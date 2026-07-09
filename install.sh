#!/bin/bash
# Command line install alternative to the UI ("+ New Plugin")
echo "Please enter your SPR path (/home/spr/super/)"
read -r SUPERDIR

if [ -z "$SUPERDIR" ]; then
    SUPERDIR="/home/spr/super/"
fi

export SUPERDIR

echo "Please enter your SPR API token:"
read -r SPR_API_TOKEN

if [ -z "$SPR_API_TOKEN" ]; then
  echo "need api token, generate one on the auth keys page"
  exit 1
fi

mkdir -p "$SUPERDIR/configs/plugins/spr-nebula"
chmod 700 "$SUPERDIR/configs/plugins/spr-nebula"

echo "SPR_API_TOKEN=$SPR_API_TOKEN" > "$SUPERDIR/configs/plugins/spr-nebula/config.sh"
printf '%s' "$SPR_API_TOKEN" > "$SUPERDIR/configs/plugins/spr-nebula/api-token"
chmod 600 "$SUPERDIR/configs/plugins/spr-nebula/api-token"

# seed an empty plugin config if none exists (configure via the UI/API afterwards)
if [ ! -f "$SUPERDIR/configs/plugins/spr-nebula/config.json" ]; then
  cat > "$SUPERDIR/configs/plugins/spr-nebula/config.json" <<'EOF'
{
  "Enabled": false,
  "Mode": "node",
  "ListenPort": 4242,
  "UseRelays": true,
  "Punchy": { "Punch": true, "Respond": true }
}
EOF
  chmod 600 "$SUPERDIR/configs/plugins/spr-nebula/config.json"
fi

docker compose build
docker compose up -d

CONTAINER_IP=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "spr-nebula")
API=127.0.0.1

curl "http://${API}/firewall/custom_interface" \
-H "Authorization: Bearer ${SPR_API_TOKEN}" \
-X 'PUT' \
--data-raw "{\"SrcIP\":\"${CONTAINER_IP}\",\"Interface\":\"spr-nebula\",\"Policies\":[\"wan\",\"dns\"]}"

docker compose restart
