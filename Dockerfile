FROM node:14

WORKDIR /usr/src/app

#RUN apt-get -o Acquire::Check-Valid-Until=false update
RUN apt-get update
RUN apt install -y libnotify-dev libgconf-2-4 libnss3 libxss1 libasound2 --allow-unauthenticated
RUN apt-get update
RUN apt-get install -y wget gnupg && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list'
RUN apt-get update && apt-get install -y fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends --allow-unauthenticated
RUN apt-get install -y fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends --allow-unauthenticated --allow-unauthenticated
RUN apt-get install -y libdrm2 libgbm1 libnss3 --allow-unauthenticated

RUN mkdir -p /usr/src/app/user_upload
RUN mkdir -p /usr/src/app/logs

COPY package*.json ./
RUN npm install --only=production
RUN npm install -g typescript@5.2.2
COPY . .
RUN npm run build
EXPOSE 3000

CMD [ "node", "dist/app.js" ]

