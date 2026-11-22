# Shorten healthy Issue Polling to a 30-second base

Status: accepted (supersedes the healthy cadence and resulting staleness threshold in [ADR 0080](0080-shorten-healthy-issue-polling-to-a-45-second-base.md))

To keep Issues current more often, a Repository's next scheduled Refresh Job becomes eligible 30 seconds plus uniform integer jitter of 0 through 15 seconds after its previous successful scheduled attempt finishes. Refresh Jobs remain serial, and manual jobs take precedence without interrupting a running attempt or changing the scheduled cadence. Consecutive scheduled-poll failures still back off from an absolute 60 seconds, doubling to a 15-minute cap independently of the healthy base. GitHub throttling still postpones until the provider retry time.

Keep the on-screen Issue projection's staleness threshold at five healthy cadence ceilings rather than preserving its previous wall-clock duration. This flags stale data sooner while keeping the same tolerance relative to healthy polling: five times 45 seconds is 3 minutes 45 seconds, down from 6 minutes 15 seconds.
