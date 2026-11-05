release: bash bin/db-connect.sh npx knex migrate:latest
web: bash bin/db-connect.sh node src/server.ts
worker: bash bin/db-connect.sh node src/worker.ts
