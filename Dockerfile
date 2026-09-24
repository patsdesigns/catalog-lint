FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# The build needs the dev dependencies (Vite, React Router dev); they are pruned after it.
RUN npm ci --include=dev && npm cache clean --force

COPY . .

RUN npm run build && npm prune --omit=dev

# The SQLite file lives where DATABASE_URL says, on a persistent disk mounted apart from prisma/
# (which holds the schema and migrations): mount the disk at /data and set
# DATABASE_URL=file:/data/tidyup.sqlite on the host. `docker-start` applies the migrations and
# starts the server; without DATABASE_URL it stops at once rather than write to a throwaway file.

CMD ["npm", "run", "docker-start"]
