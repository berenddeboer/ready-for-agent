# Host the job worker in Harness

The job worker runs as a long-lived scoped service in the Harness application runtime, using Effect fibers for polling and job execution rather than running as a separate OS process. This keeps the first worker operationally simple and lets it reuse Harness services, including credential-backed GitHub access; the trade-off is that application shutdowns and development reloads interrupt in-flight work, which the database queue must safely redeliver.
