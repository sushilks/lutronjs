FROM ubuntu:16.04
RUN apt-get update
RUN apt-get install -y build-essential openssh-server apache2
RUN apt-get install -y linux-headers-$(uname -r)
RUN apt-get install -y locales
RUN echo "en_US.UTF-8 UTF-8" > /etc/locale.gen
RUN locale-gen && dpkg-reconfigure locales --terse
RUN apt-get install -y language-pack-en
RUN apt-get update
RUN apt-get install -y curl git
RUN curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.2/install.sh | bash
RUN bash -c ". /root/.nvm/nvm.sh && nvm install v6.11.2"
RUN cd /root && git clone https://github.com/sushilks/lutronjs.git
RUN bash -c ". /root/.nvm/nvm.sh && cd /root/lutronjs && npm install"
RUN bash -c ". /root/.nvm/nvm.sh && cd /root/lutronjs && npm run build"
RUN echo "cd /root/lutronjs && npm run server" > /root/run_lutronjs.sh
RUN chmod +x /root/run_lutronjs.sh
