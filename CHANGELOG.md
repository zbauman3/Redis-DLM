# Changelog

## 1.1.0 (2022-01-25)
- `release` now resolves to the number of instances that confirmed the release. It also only rejects when a consensus for the release was not achieved.
- Settings are now considered valid only if:
  - `duration > 0`
  - `retryCount >= 0`
  - `retryDelay > 0`
  - `maxHoldTime > 0`
  - `driftFactor >= 0 && driftFactor <= 1`
  - `driftConstant >= 0`

## 1.0.4 (2022-01-20)
- Changed `aquire` to `acquire` and added a depreciated alias.