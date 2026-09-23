FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

# The build needs the dev dependencies (Vite, React Router dev); they are pruned after it.
RUN npm ci --include=dev && npm cache clean --force

COPY . .

RUN npm run build && npm prune --omit=dev

# The SQLite database lives in prisma/ (prisma/schema.prisma): mount a volume there so it survives
# a new container. `docker-start` applies the migrations and starts the server.
VOLUME ["/app/prisma"]

CMD ["npm", "run", "docker-start"]
