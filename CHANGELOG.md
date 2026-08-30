# Changelog

## [0.1.2](https://github.com/applogico/blipr-js/compare/js-v0.1.1...js-v0.1.2) (2026-08-30)


### Bug Fixes

* send a comma-separated topic list without the spaces around it ([#13](https://github.com/applogico/blipr-js/issues/13)) ([58d8e57](https://github.com/applogico/blipr-js/commit/58d8e57613e369fc1ca73bcbf42d7f5d4ac6fb7b))

## [0.1.1](https://github.com/applogico/blipr-js/compare/js-v0.1.0...js-v0.1.1) (2026-08-29)


### Bug Fixes

* say the topic must exist, and carry the server reason on a failure ([#8](https://github.com/applogico/blipr-js/issues/8)) ([334c8bd](https://github.com/applogico/blipr-js/commit/334c8bd8f4965fe4b61a752f85c909ab774edb32))

## 0.1.0 (2026-07-20)

### Features

* Initial release — zero-dependency publish/subscribe client for Blipr.
* `publish()` with the full `X-*` header contract (priority, tags, click, icon, markdown, reply/ask loop) and token support.
* `subscribe()` + `messages()` async-iterable over SSE with auto-reconnect and resume-from-last-message.
