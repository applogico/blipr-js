# Changelog

## 0.1.0 (2026-07-20)

### Features

* Initial release — zero-dependency publish/subscribe client for Blipr.
* `publish()` with the full `X-*` header contract (priority, tags, click, icon, markdown, reply/ask loop) and token support.
* `subscribe()` + `messages()` async-iterable over SSE with auto-reconnect and resume-from-last-message.
