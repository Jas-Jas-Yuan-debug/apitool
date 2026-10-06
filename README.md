# Relay

A local chat playground for OpenAI-compatible APIs. Enter your API key and base URL, load or type a model ID, select reasoning effort, and send messages.

## Run

Clone [Jas-Jas-Yuan-debug/apitool](https://github.com/Jas-Jas-Yuan-debug/apitool), then open the repository folder.

Requires Node.js 22 or newer.

```sh
npm install
npm start
```

Open **http://127.0.0.1:3210/**. Stop the server with Ctrl+C. To use another port:

```sh
PORT=3215 npm start
```

The server only listens on your computer's loopback interface.

## Use

1. Enter a base URL, such as `https://api.openai.com/v1`, or your provider's OpenAI-compatible API root. Custom prefixes are preserved. For local providers, HTTP loopback URLs like `http://127.0.0.1:11434/v1` work.
2. Paste the API key. Leave it empty for a local provider that does not need authentication.
3. Click **Connect & load models**, then open the **Model dropdown** and choose any returned model. All choices remain available after selection. On a small screen, a successful connection closes the sidebar and focuses the dropdown.
4. If model listing is unavailable, choose **Custom model ID…** and type the exact ID in the separate field. A failed listing also offers a **Continue with a custom model ID** button. Changing the base URL clears the previous provider's selection; a saved ID missing from a refreshed list is shown explicitly as a custom ID.
5. Select the reasoning effort and send a message. **Auto** omits the effort parameter, allowing the provider to choose its default. Other values depend on the selected model; unsupported settings show the provider's error. Selected settings stay unchanged throughout a reply. With web search enabled, tool use can require several provider calls, which your provider may bill separately.
6. Use **Settings** to pick the API format or add a system prompt. Auto selects Responses for `api.openai.com` and also for GPT-6.1 Sol/GPT-6 Astra with AI web search enabled, including compatible endpoints. Other hosts/models use Chat Completions in Auto. An explicit API format stays unchanged.

Enter sends; Shift+Enter adds a new line. Cmd/Ctrl+K opens a new conversation. You can stop generation, retry a failed reply, regenerate a completed reply, copy replies/code, export a conversation as Markdown, and switch themes.

While a reply is running, Send is disabled and repeated submissions are ignored. Use the separate **Stop generating** button to cancel; a second Send click or Enter submission does not stop the reply.

Replies appear as provider events arrive, with a small status showing waiting, thinking, searching, or streaming. Responses-compatible providers that send finalized content parts without text deltas are displayed as soon as those parts arrive. A provider that returns only one JSON response cannot deliver text before it finishes; Relay does not simulate token streaming.

GPT image and DALL-E models use the Images API automatically. A text prompt goes to `images/generations`; attaching PNG, JPEG, or WebP images uses `images/edits` for supported models. GPT image models request native streaming with two partial previews; providers may instead return one completed JSON image. Generated pictures render in the same chat, offer a download, and are saved in browser storage and chat backups. Remote image URLs appear as links. Image requests use the latest prompt and its text/image attachments; reasoning effort and web search apply to chat models. Each returned picture is limited to 8 MiB. Images API support and preview availability depend on the selected provider.

### Reply statistics

Each reply ends with a compact table comparing that reply with the whole conversation: input/output/total tokens, **首字延迟** (time to the first answer text), total response time, and output tokens per second both including and excluding the first-text delay. First-text timing starts when the request is sent; waiting, reasoning, and web searches before the answer are included in the delay. Total time ends when the response completes or stops.

Reply speed is output tokens divided by total seconds, or by total seconds minus the first-text delay. Conversation speed uses summed output tokens and summed times, rather than averaging individual rates. Conversation tokens include the input context sent again in each provider call, tool continuations, and known usage from replaced retry/regeneration attempts. Conversation time and delay are sums of those attempts, excluding time spent reading or typing between messages.

Token counts come from the provider; Relay does not estimate them from visible text. Output tokens may include reasoning tokens when the provider counts them that way. Missing usage, old replies without measured first-text timing, and stopped replies are shown as **N/A** or **partial**, with no misleading complete-conversation speed. Image generation can report token usage and elapsed time, but has no answer-text latency or text speed. Statistics survive refresh and chat backups; archived retry statistics contain no prompt, answer, file content, or API key.

### Files and web search

- **Attach files** adds up to five files to the next message in your current chat. Preview and remove pending files before sending. Images (PNG/JPEG/WebP/GIF), PDFs, and UTF-8 text/code work through both API formats when the selected model supports them. DOCX, XLSX, and PPTX use the Responses format; the app explains this before sending and keeps your draft.
- **AI web search** is on by default. Send your question normally: the selected model decides whether to call the `web_search` tool and writes its own query. Relay runs that query, returns source titles, links, and snippets to the model, then continues the same reply. Search progress and sources appear in the conversation. You can turn the toggle off for a message to send through the ordinary chat path.
- Research is bounded to four tool rounds and six distinct searches per reply. Repeated queries reuse that reply's earlier results, including search errors. At the budget, Relay closes tool use and makes one final provider request asking the model to answer from collected evidence and explain any missing information. The conversation and sources stay available. A provider that ignores the final no-tools instruction reports a clear compatibility error instead of making more searches.
- Autonomous search requires a model and provider that support function tools in the selected API format. The model may answer without searching when it does not request the tool. General searches use Bing RSS; news and headline queries use Google News RSS with publication dates and publishers. Clear recent-news queries use a two-day window unless the query already specifies dates or history. Old, undated, and future-dated articles are excluded from that window; no matching articles means no evidence, rather than unrelated homepages. Each search returns up to six linked results without another API key. Only the chosen query goes to the search service, with no provider credential. Queries can reflect conversation details. Results are headlines and feed excerpts; Relay does not open the linked pages or browse entire websites. Public feeds can rate-limit requests or return broad results, and snippets can be incomplete.
- Earlier attached files and search references remain available in subsequent turns and retries. If a provider rejects a file, use its **Exclude from future messages** control to continue the same chat. The original file, messages, and replies remain saved; the control can include the file again.
- Draft text, pending files, search results, and the selected chat are restored on refresh and when switching conversations. Your API key still clears on refresh. The **Download chat backup with files** button saves a JSON snapshot including file contents and drafts. Markdown export includes text attachments and source links; binary files are listed by name.

## Data and scope

- The API key stays in this tab's memory and in active requests. It is never saved to disk or browser storage. Reloading clears it.
- Chats, preferences, drafts, and files are saved in this browser's IndexedDB, with local storage as a fallback. The 50 most recent chats are saved. Storage failures leave the current session intact and show backup guidance. Download a chat backup for conversations you want to keep separately.
- Requests travel from the browser to the server on your computer, then to the base URL you chose. Your provider receives your messages and API key. This tool has no analytics or external asset requests.
- HTTP upstream connections are allowed only for loopback hosts; other providers require HTTPS. Redirects are rejected so credentials do not follow redirects.
- Chat context includes user messages and completed assistant replies. Stopped or failed replies are retained visibly but excluded from subsequent request context. Retry replaces the last assistant attempt.
- The app sends text, file inputs, and web reference snippets to your selected provider. Responses requests use `store: false`; conversation context and included files are replayed each turn.
- Model-specific API compatibility and reasoning effort support are determined by your provider. A successful model-list request does not guarantee every listed model supports text chat.
- Chat requests are limited to 16 MiB and 500 messages. Each file is at most 5 MiB; included files across the replayed conversation total at most 10 MiB, and attached text totals at most 200,000 characters. Limit checks keep your draft and existing chat. Provider calls time out after 10 minutes; web search times out after 15 seconds.

## Validation

```sh
npm run check
npm test
```

Tests use local mock providers; they do not make paid API calls or require credentials. They cover request mapping, model discovery, both streaming formats, fragmented Unicode/SSE, JSON fallback, provider errors, truncation, cancellation, request history, attachment payloads, autonomous search tool calls, per-chat drafts, and credential-free storage.

For a manual browser test, run `node tests/mock-provider.mjs` in a second terminal. Connect to `http://127.0.0.1:3211/v1`, select `demo-chat` or `demo-reasoning`, and use any disposable test key. Send `slow` to test stopping or `error` to test a provider error. Select **demo-web-search**, leave AI web search on, and send `Search why is Mars red` to exercise a genuine function-call request followed by an answer citing returned source snippets. **demo-search-loop** repeats its first query, asks focused refinements, and answers from returned evidence when Relay closes tool use. The local model fixtures simulate model behavior; their tool calls use the app's normal search service, so these browser demos may contact Bing. Automated route tests inject search results and remain entirely local. This fixture is separate from the normal app server.

Model-list fixtures also support `/empty/v1`, `/malformed/v1`, `/wrong-shape/v1`, `/error/v1`, `/slow/v1`, `/huge/v1`, `/strings/v1`, and `/names/v1` under the same local mock host.

API formats follow the official [streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses), [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning), [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), and [model-list reference](https://developers.openai.com/api/reference/resources/models/methods/list).

File payloads follow the official [file-input guide](https://developers.openai.com/api/docs/guides/file-inputs) and [image-input guide](https://developers.openai.com/api/docs/guides/images-vision). Supported file/model features ultimately depend on your provider.

## License

Copyright (C) 2026 Jas-Jas-Yuan-debug. Relay's original source is licensed under the **GNU Affero General Public License, version 3 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE) for redistribution terms and the warranty disclaimer. There is no warranty.

Third-party dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Contributions to the original project source are provided under AGPL-3.0-only.
