FROM node:16

WORKDIR /usr/src/app

# Switch old repos to archive repos
RUN sed -i 's|deb.debian.org|archive.debian.org|g' /etc/apt/sources.list \
 && sed -i '/security.debian.org/d' /etc/apt/sources.list \
 && echo "deb http://archive.debian.org/debian/ buster main contrib non-free" > /etc/apt/sources.list

RUN apt-get -o Acquire::Check-Valid-Until=false update

RUN apt install -y libnotify-dev libgconf-2-4 libnss3 libxss1 libasound2 --allow-unauthenticated
RUN apt-get update
RUN apt-get install -y wget gnupg && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list'
RUN apt-get update && apt-get install -y fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends --allow-unauthenticated
RUN apt-get install -y fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 fonts-noto-cjk fonts-noto-ui-core fonts-noto-color-emoji fonts-kannada fonts-lohit-knda fonts-navilu --no-install-recommends --allow-unauthenticated --allow-unauthenticated
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

