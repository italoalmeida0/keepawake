# Changelog

## 1.0.1-rc.1

Preview for validation on the affected managed laptop.

- Use the documented `powercfg` lid-configuration path recovered from the original setup; keep native writes available for explicit comparison.
- Identify the configuration backend and failing operation, including Group Policy error 1260.
- Add read-only `doctor` reports, separate lid status, and tray warnings for unverified lid protection.
- Avoid unnecessary active-plan reactivation when lid settings are already correct or a first write was rejected.
- Preserve pending restoration applies in the backup journal and report unavailable activity simulation.
- Normalize powercfg Group Policy override failures to Windows error 1260.
- Eliminate stale backups after rolled-back configuration failures, preserving journals only for un-restored settings when rollback fails.

Automated checks do not establish that an enforced company policy can be overridden. Physical validation on the affected laptop remains required before treating this preview as a confirmed behavioral fix.

## 1.0.0

Initial public Node.js and Koffi release with a native tray, standard-user runtime and startup, single-instance control, and backed-up lid settings.
