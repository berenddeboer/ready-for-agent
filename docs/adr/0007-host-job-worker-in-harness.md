# Host the job worker in Harness

The job worker runs as a long-lived scoped service in the Harness application runtime, using Effect fibers for polling and job execution rather than running as a separate OS process. This keeps the first worker operationally simple and lets it reuse Harness services, including credential-backed GitHub access.

Application shutdowns and development reloads end in-flight Step Runs. On job-worker startup, every Step Run still marked `running` from a prior process generation is transitioned to Interrupted (`worker_restarted`), its Worker Slot is released, and its queue job is acknowledged — not silently redelivered. Long agent steps (e.g. Build/`implement`) require operator Retry. Lease-expiry orphan recovery remains a backstop for missing jobs and exhausted locks; process-epoch ownership is the primary fix for harness restart zombies. Graceful dispose best-effort interrupts in-process Step Runs; hard kill relies on the next startup sweep.
