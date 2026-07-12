# Design

- SPA: no need for SSR
- API is graphql (genql)
- Database is Turso database (sqlite)
- Backend is Effect TS
- ulids for ids.
- Services are implemented as Effect TS
- Separate job worker who handles jobs
- UI is responsive: anything that takes long is put in a queue and handled by the job worker
