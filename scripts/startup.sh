#!/bin/bash
set -a
. /configs/base/config.sh
if [ -f /configs/spr-nebula/config.sh ]; then
  . /configs/spr-nebula/config.sh
fi
set +a

mkdir -p /configs/spr-nebula
chmod 700 /configs/spr-nebula

# the nebula daemon itself is supervised by the plugin binary
exec /nebula_plugin
