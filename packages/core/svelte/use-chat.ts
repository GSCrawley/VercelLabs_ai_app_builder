import { useSWR } from 'sswr';
import { Readable, Writable, derived, get, writable } from 'svelte/store';
import { callApi } from '../shared/call-api';
import { processChatStream } from '../shared/process-chat-stream';
import type {
  ChatRequest,
  ChatRequestOptions,
  CreateMessage,
  JSONValue,
  Message,
  UseChatOptions,
} from '../shared/types';
import { nanoid } from '../shared/utils';
export type { CreateMessage, Message, UseChatOptions };

export type UseChatHelpers = {
  /** Current messages in the chat */
  messages: Readable<Message[]>;
  /** The error object of the API request */
  error: Readable<undefined | Error>;
  /**
   * Append a user message to the chat list. This triggers the API call to fetch
   * the assistant's response.
   * @param message The message to append
   * @param chatRequestOptions Additional options to pass to the API call
   */
  append: (
    message: Message | CreateMessage,
    chatRequestOptions?: ChatRequestOptions,
  ) => Promise<string | null | undefined>;
  /**
   * Reload the last AI chat response for the given chat history. If the last
   * message isn't from the assistant, it will request the API to generate a
   * new response.
   */
  reload: (
    chatRequestOptions?: ChatRequestOptions,
  ) => Promise<string | null | undefined>;
  /**
   * Abort the current request immediately, keep the generated tokens if any.
   */
  stop: () => void;
  /**
   * Update the `messages` state locally. This is useful when you want to
   * edit the messages on the client, and then trigger the `reload` method
   * manually to regenerate the AI response.
   */
  setMessages: (messages: Message[]) => void;
  /** The current value of the input */
  input: Writable<string>;
  /** Form submission handler to automatically reset input and append a user message  */
  handleSubmit: (e: any, chatRequestOptions?: ChatRequestOptions) => void;
  metadata?: Object;
  /** Whether the API request is in progress */
  isLoading: Readable<boolean | undefined>;

  /** Additional data added on the server via StreamData */
  data: Readable<JSONValue[] | undefined>;
};
const getStreamedResponse = async (
  api: string,
  chatRequest: ChatRequest,
  mutate: (messages: Message[]) => void,
  mutateStreamData: (data: JSONValue[] | undefined) => void,
  existingData: JSONValue[] | undefined,
  extraMetadata: {
    credentials?: RequestCredentials;
    headers?: Record<string, string> | Headers;
    body?: any;
  },
  previousMessages: Message[],
  abortControllerRef: AbortController | null,
  onFinish?: (message: Message) => void,
  onResponse?: (response: Response) => void | Promise<void>,
  sendExtraMessageFields?: boolean,
) => {
  // Do an optimistic update to the chat state to show the updated messages
  // immediately.
  mutate(chatRequest.messages);

  const constructedMessagesPayload = sendExtraMessageFields
    ? chatRequest.messages
    : chatRequest.messages.map(({ role, content, name, function_call }) => ({
        role,
        content,
        ...(name !== undefined && { name }),
        ...(function_call !== undefined && {
          function_call: function_call,
        }),
      }));

  return await callApi({
    api,
    messages: constructedMessagesPayload,
    body: {
      ...extraMetadata.body,
      ...chatRequest.options?.body,
      ...(chatRequest.functions !== undefined && {
        functions: chatRequest.functions,
      }),
      ...(chatRequest.function_call !== undefined && {
        function_call: chatRequest.function_call,
      }),
    },
    credentials: extraMetadata.credentials,
    headers: {
      ...extraMetadata.headers,
      ...chatRequest.options?.headers,
    },
    abortController: () => abortControllerRef,
    appendMessage(message) {
      mutate([...chatRequest.messages, message]);
    },
    restoreMessagesOnFailure() {
      mutate(previousMessages);
    },
    onResponse,
    onUpdate(merged, data) {
      mutate([...chatRequest.messages, ...merged]);
      mutateStreamData([...(existingData || []), ...(data || [])]);
    },
    onFinish,
  });
};

let uniqueId = 0;

const store: Record<string, Message[] | undefined> = {};

export function useChat({
  api = '/api/chat',
  id,
  initialMessages = [],
  initialInput = '',
  sendExtraMessageFields,
  experimental_onFunctionCall,
  onResponse,
  onFinish,
  onError,
  credentials,
  headers,
  body,
}: UseChatOptions = {}): UseChatHelpers {
  // Generate a unique id for the chat if not provided.
  const chatId = id || `chat-${uniqueId++}`;

  const key = `${api}|${chatId}`;
  const {
    data,
    mutate: originalMutate,
    isLoading: isSWRLoading,
  } = useSWR<Message[]>(key, {
    fetcher: () => store[key] || initialMessages,
    fallbackData: initialMessages,
  });

  const streamData = writable<JSONValue[] | undefined>(undefined);

  const loading = writable<boolean>(false);

  // Force the `data` to be `initialMessages` if it's `undefined`.
  data.set(initialMessages);

  const mutate = (data: Message[]) => {
    store[key] = data;
    return originalMutate(data);
  };

  // Because of the `fallbackData` option, the `data` will never be `undefined`.
  const messages = data as Writable<Message[]>;

  // Abort controller to cancel the current API call.
  let abortController: AbortController | null = null;

  const extraMetadata = {
    credentials,
    headers,
    body,
  };

  const error = writable<undefined | Error>(undefined);

  // Actual mutation hook to send messages to the API endpoint and update the
  // chat state.
  async function triggerRequest(chatRequest: ChatRequest) {
    try {
      error.set(undefined);
      loading.set(true);
      abortController = new AbortController();

      await processChatStream({
        getStreamedResponse: () =>
          getStreamedResponse(
            api,
            chatRequest,
            mutate,
            data => {
              streamData.set(data);
            },
            get(streamData),
            extraMetadata,
            get(messages),
            abortController,
            onFinish,
            onResponse,
            sendExtraMessageFields,
          ),
        experimental_onFunctionCall,
        updateChatRequest: chatRequestParam => {
          chatRequest = chatRequestParam;
        },
        getCurrentMessages: () => get(messages),
      });

      abortController = null;

      return null;
    } catch (err) {
      // Ignore abort errors as they are expected.
      if ((err as any).name === 'AbortError') {
        abortController = null;
        return null;
      }

      if (onError && err instanceof Error) {
        onError(err);
      }

      error.set(err as Error);
    } finally {
      loading.set(false);
    }
  }

  const append: UseChatHelpers['append'] = async (
    message: Message | CreateMessage,
    { options, functions, function_call }: ChatRequestOptions = {},
  ) => {
    if (!message.id) {
      message.id = nanoid();
    }

    const chatRequest: ChatRequest = {
      messages: get(messages).concat(message as Message),
      options,
      ...(functions !== undefined && { functions }),
      ...(function_call !== undefined && { function_call }),
    };
    return triggerRequest(chatRequest);
  };

  const reload: UseChatHelpers['reload'] = async ({
    options,
    functions,
    function_call,
  }: ChatRequestOptions = {}) => {
    const messagesSnapshot = get(messages);
    if (messagesSnapshot.length === 0) return null;

    // Remove last assistant message and retry last user message.
    const lastMessage = messagesSnapshot.at(-1);
    if (lastMessage?.role === 'assistant') {
      const chatRequest: ChatRequest = {
        messages: messagesSnapshot.slice(0, -1),
        options,
        ...(functions !== undefined && { functions }),
        ...(function_call !== undefined && { function_call }),
      };

      return triggerRequest(chatRequest);
    }
    const chatRequest: ChatRequest = {
      messages: messagesSnapshot,
      options,
      ...(functions !== undefined && { functions }),
      ...(function_call !== undefined && { function_call }),
    };

    return triggerRequest(chatRequest);
  };

  const stop = () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  };

  const setMessages = (messages: Message[]) => {
    mutate(messages);
  };

  const input = writable(initialInput);

  const handleSubmit = (e: any, options: ChatRequestOptions = {}) => {
    e.preventDefault();
    const inputValue = get(input);
    if (!inputValue) return;

    append(
      {
        content: inputValue,
        role: 'user',
        createdAt: new Date(),
      },
      options,
    );
    input.set('');
  };

  const isLoading = derived(
    [isSWRLoading, loading],
    ([$isSWRLoading, $loading]) => {
      return $isSWRLoading || $loading;
    },
  );

  return {
    messages,
    error,
    append,
    reload,
    stop,
    setMessages,
    input,
    handleSubmit,
    isLoading,
    data: streamData,
  };
}
