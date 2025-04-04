#!/bin/bash
# Installer systemavhengigheter for yt-dlp
apt-get update
apt-get install -y python3 python3-pip ffmpeg
# Installer yt-dlp
pip3 install yt-dlp
# Kjør npm install for Node.js-avhengigheter
npm install
