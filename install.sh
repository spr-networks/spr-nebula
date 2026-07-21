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

KRUN_MAC="02:53:50:52:4b:0b"
PLUGIN_INTERFACE="spr-nebula"
curl --fail-with-body --silent --show-error "http://127.0.0.1/device?identity=${KRUN_MAC}" \
  -H "Authorization: Bearer ${SPR_API_TOKEN}" -H "Content-Type: application/json" \
  -X PUT --data-raw "{\"MAC\":\"${KRUN_MAC}\",\"Name\":\"spr-nebula\",\"Policies\":[\"wan\",\"dns\"],\"Groups\":[\"nebula\"]}" >/dev/null
if ! sudo nft get element inet filter dhcp_access "{ \"${PLUGIN_INTERFACE}\" . ${KRUN_MAC} }" >/dev/null 2>&1; then
  sudo nft add element inet filter dhcp_access "{ \"${PLUGIN_INTERFACE}\" . ${KRUN_MAC} : accept }"
fi

docker compose -f docker-compose-kvm.yml build
docker compose -f docker-compose-kvm.yml up -d

CONTAINER_IP=
for _ in $(seq 1 30); do
  CONTAINER_IP="$(jq -r --arg mac "$KRUN_MAC" '.[$mac].RecentIP // empty' "$SUPERDIR/state/public/devices-public.json")"
  [ -n "$CONTAINER_IP" ] && break
  sleep 1
done
[ -n "$CONTAINER_IP" ] || { echo "spr-nebula did not obtain an SPR DHCP lease" >&2; exit 1; }
API=127.0.0.1

curl "http://${API}/firewall/custom_interface" \
-H "Authorization: Bearer ${SPR_API_TOKEN}" \
-X 'PUT' \
--data-raw "{\"SrcIP\":\"${CONTAINER_IP}\",\"Interface\":\"${PLUGIN_INTERFACE}\",\"Policies\":[\"wan\",\"dns\"],\"Groups\":[\"nebula\"]}"

docker compose -f docker-compose-kvm.yml restart
