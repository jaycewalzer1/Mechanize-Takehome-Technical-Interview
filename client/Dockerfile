FROM node:22-alpine
WORKDIR /app
# Built from the repo root (see docker-compose.yml) because the lockfile is the
# npm-workspace one at the root: `npm ci` installs exactly the tested versions,
# and fails instead of drifting if package.json and the lockfile disagree.
COPY package.json package-lock.json ./
COPY client/package.json client/
RUN npm ci
COPY client/ client/
CMD ["npm", "run", "dev", "--workspace", "client"]
