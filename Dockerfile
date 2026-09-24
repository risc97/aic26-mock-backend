FROM node:24-alpine 

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
COPY data/ ./data/

RUN npm run build

EXPOSE 3000
ENV PORT=3000

CMD ["npm", "start"]
