FROM ubuntu:latest
RUN apt update
RUN apt install -y nodejs
WORKDIR /root/lutronjs
ADD node_modules node_modules
ADD build build
ADD README.md .
ADD lutron.pem .
ADD package.json .
RUN echo "cd /root/lutronjs &&  node --harmony ./build/lutronServer.js" > /root/run_lutronjs.sh
RUN chmod +x /root/run_lutronjs.sh
CMD /root/run_lutronjs.sh
