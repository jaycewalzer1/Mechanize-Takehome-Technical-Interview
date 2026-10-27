FROM node:22-alpine
WORKDIR /app
COPY package.json ./
# LIMITATION: the lockfile is the npm-workspace one at the repo root, outside this
# build context, so `npm install` resolves the newest versions the ^ ranges allow
# (a fresh build already got vite 6.4.5 / react 19.3.1 vs the tested 6.4.1 / 19.2.4).
# Future update: build from the repo root, copy package-lock.json, and use `npm ci`,
# because an unpinned build can break, or behave differently, without any code change.
RUN npm install
COPY . .
CMD ["npm", "run", "dev"]
