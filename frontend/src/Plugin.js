import React, { useEffect, useState } from 'react'
import {
  api,
  useAlert,
  Page,
  ListHeader,
  Card,
  SectionHeader,
  StatTile,
  KeyVal,
  StatusDot,
  Toggle,
  TextField,
  ModalForm,
  ModalConfirm,
  Loading,
  Button,
  ButtonText,
  HStack,
  VStack,
  Text,
  Textarea,
  TextareaInput
} from '@spr-networks/plugin-ui'

const PLUGIN_BASE = `/plugins/${api.pluginURI() || 'spr-nebula'}`

const csv = (s) =>
  (s || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length)

const copyText = (text) => {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text)
  }
  // iframe fallback
  const el = document.createElement('textarea')
  el.value = text
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  el.remove()
  return Promise.resolve()
}

const downloadText = (filename, text) => {
  const el = document.createElement('a')
  el.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text)
  el.download = filename
  document.body.appendChild(el)
  el.click()
  el.remove()
}

const PemBlock = ({ label, value, filename, onCopied }) => (
  <VStack space="xs">
    <HStack justifyContent="space-between" alignItems="center">
      <Text size="sm" bold>
        {label}
      </Text>
      <HStack space="sm">
        <Button
          size="xs"
          variant="outline"
          onPress={() => copyText(value).then(() => onCopied && onCopied(label))}
        >
          <ButtonText>Copy</ButtonText>
        </Button>
        <Button size="xs" variant="outline" onPress={() => downloadText(filename, value)}>
          <ButtonText>Download</ButtonText>
        </Button>
      </HStack>
    </HStack>
    <Textarea h={120} isReadOnly>
      <TextareaInput
        value={value}
        editable={false}
        multiline
        fontFamily="monospace"
        fontSize={11}
      />
    </Textarea>
  </VStack>
)

export default function Plugin() {
  const alert = useAlert()
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState(null)
  const [caConfigured, setCAConfigured] = useState(false)
  const [certConfigured, setCertConfigured] = useState(false)

  // config form state
  const [enabled, setEnabled] = useState(false)
  const [lighthouseMode, setLighthouseMode] = useState(false)
  const [cidr, setCidr] = useState('')
  const [listenPort, setListenPort] = useState('4242')
  const [lighthouses, setLighthouses] = useState('')
  const [relays, setRelays] = useState('')
  const [amRelay, setAmRelay] = useState(false)
  const [useRelays, setUseRelays] = useState(true)
  const [punch, setPunch] = useState(true)
  const [punchRespond, setPunchRespond] = useState(true)
  const [allowICMP, setAllowICMP] = useState(false)
  const [hostMap, setHostMap] = useState([]) // [{ip, endpoints}]
  const [newMapIP, setNewMapIP] = useState('')
  const [newMapEndpoints, setNewMapEndpoints] = useState('')

  // CA / cert state
  const [caName, setCaName] = useState('SPR Nebula CA')
  const [caCert, setCaCert] = useState('')
  const [showRegenCA, setShowRegenCA] = useState(false)
  const [certName, setCertName] = useState('')
  const [certIP, setCertIP] = useState('')
  const [certGroups, setCertGroups] = useState('')
  const [certInstall, setCertInstall] = useState(false)
  const [issued, setIssued] = useState(null) // {Cert, Key, Installed}
  const [importCA, setImportCA] = useState('')
  const [importCert, setImportCert] = useState('')
  const [importKey, setImportKey] = useState('')

  const applyConfig = (c) => {
    setEnabled(!!c.Enabled)
    setLighthouseMode(c.Mode === 'lighthouse')
    setCidr(c.CIDR || '')
    setListenPort(String(c.ListenPort ?? 4242))
    setLighthouses((c.LighthouseHosts || []).join(', '))
    setRelays((c.Relays || []).join(', '))
    setAmRelay(!!c.AmRelay)
    setUseRelays(!!c.UseRelays)
    setPunch(!!(c.Punchy && c.Punchy.Punch))
    setPunchRespond(!!(c.Punchy && c.Punchy.Respond))
    setAllowICMP(!!c.InboundAllowICMP)
    setHostMap(
      Object.entries(c.StaticHostMap || {}).map(([ip, eps]) => ({
        ip,
        endpoints: (eps || []).join(', ')
      }))
    )
    setCAConfigured(!!c.CAConfigured)
    setCertConfigured(!!c.CertConfigured)
  }

  const refresh = () => {
    Promise.all([
      api.get(`${PLUGIN_BASE}/config`),
      api.get(`${PLUGIN_BASE}/status`)
    ])
      .then(([c, s]) => {
        applyConfig(c)
        setStatus(s)
      })
      .catch((err) => alert.error('Failed to load plugin state', err))
      .finally(() => setLoading(false))
  }

  const refreshStatus = () => {
    api
      .get(`${PLUGIN_BASE}/status`)
      .then(setStatus)
      .catch(() => {})
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refreshStatus, 15000)
    return () => clearInterval(t)
  }, [])

  const buildConfig = () => {
    const map = {}
    for (let row of hostMap) {
      if (row.ip.trim().length) {
        map[row.ip.trim()] = csv(row.endpoints)
      }
    }
    return {
      Enabled: enabled,
      Mode: lighthouseMode ? 'lighthouse' : 'node',
      CIDR: cidr.trim(),
      ListenPort: parseInt(listenPort, 10) || 0,
      LighthouseHosts: lighthouseMode ? [] : csv(lighthouses),
      StaticHostMap: map,
      Relays: csv(relays),
      AmRelay: amRelay,
      UseRelays: useRelays,
      Punchy: { Punch: punch, Respond: punchRespond },
      InboundAllowICMP: allowICMP
    }
  }

  const save = () => {
    api
      .put(`${PLUGIN_BASE}/config`, buildConfig())
      .then((c) => {
        applyConfig(c)
        alert.success('Configuration saved')
        refreshStatus()
      })
      .catch((err) => alert.error('Failed to save', err))
  }

  const restart = () => {
    api
      .post(`${PLUGIN_BASE}/restart`, {})
      .then(() => {
        alert.success('Nebula restarted')
        refreshStatus()
      })
      .catch((err) => alert.error('Restart failed', err))
  }

  const createCA = (force) => {
    api
      .post(`${PLUGIN_BASE}/ca`, { Name: caName, Force: !!force })
      .then((res) => {
        setCaCert(res.CACert || '')
        setCAConfigured(true)
        alert.success('CA created — private key stays on the router')
        refreshStatus()
      })
      .catch((err) => alert.error('Failed to create CA', err))
  }

  const fetchCA = () => {
    api
      .get(`${PLUGIN_BASE}/ca`)
      .then((res) => setCaCert(res.CACert || ''))
      .catch((err) => alert.error('Failed to fetch CA certificate', err))
  }

  const issueCert = () => {
    api
      .post(`${PLUGIN_BASE}/certs`, {
        Name: certName,
        IP: certIP,
        Groups: csv(certGroups),
        Install: certInstall
      })
      .then((res) => {
        setIssued(res)
        if (res.Installed) {
          alert.success('Certificate installed as this router\'s identity')
          setCertConfigured(true)
          refreshStatus()
        }
      })
      .catch((err) => alert.error('Failed to issue certificate', err))
  }

  const importKeys = () => {
    api
      .post(`${PLUGIN_BASE}/keys/import`, {
        CACert: importCA,
        HostCert: importCert,
        HostKey: importKey
      })
      .then((res) => {
        setCAConfigured(!!res.CAConfigured)
        setCertConfigured(!!res.CertConfigured)
        setImportCA('')
        setImportCert('')
        setImportKey('')
        alert.success('Credentials imported')
        refreshStatus()
      })
      .catch((err) => alert.error('Import failed', err))
  }

  if (loading) {
    return (
      <Page>
        <Loading text="Loading nebula plugin..." />
      </Page>
    )
  }

  const st = status || {}
  const certDetails = (() => {
    let ci = st.CertInfo
    if (Array.isArray(ci)) ci = ci[0]
    return (ci && ci.details) || null
  })()

  return (
    <Page>
      <ListHeader
        title="Nebula"
        description="Overlay mesh network (slackhq/nebula)"
      >
        <Button size="sm" variant="outline" onPress={restart} isDisabled={!enabled}>
          <ButtonText>Restart</ButtonText>
        </Button>
        <Button size="sm" onPress={save}>
          <ButtonText>Save</ButtonText>
        </Button>
      </ListHeader>

      <Card>
        <SectionHeader
          title="Status"
          right={<StatusDot online={!!st.Running && !!st.InterfaceUp} warn={!!st.Running && !st.InterfaceUp} />}
        />
        <HStack flexWrap="wrap" gap="$2">
          <StatTile label="Daemon" value={st.Running ? 'Running' : 'Stopped'} />
          <StatTile label="Mode" value={st.Mode || 'node'} />
          <StatTile
            label="Interface"
            value={`${st.InterfaceName || 'nebula1'} ${st.InterfaceUp ? 'up' : 'down'}`}
            mono
          />
          <StatTile
            label="Overlay IP"
            value={(st.InterfaceIPs || []).join(' ') || '—'}
            mono
          />
          <StatTile label="UDP Port" value={String(st.ListenPort ?? '—')} mono />
          {st.NebulaVersion ? (
            <StatTile label="Nebula" value={st.NebulaVersion} mono />
          ) : null}
        </HStack>
        <VStack space="sm" mt="$2">
          {(st.Lighthouses || []).map((lh) => (
            <HStack key={lh.Host} space="sm" alignItems="center">
              <StatusDot online={lh.Reachable} />
              <Text size="sm" fontFamily="monospace">
                {lh.Host}
              </Text>
              <Text size="sm" color="$muted500">
                {lh.Reachable ? 'lighthouse reachable' : 'lighthouse unreachable'}
              </Text>
            </HStack>
          ))}
          {certDetails ? (
            <VStack space="xs" mt="$1">
              <KeyVal label="Certificate" value={certDetails.name} mono />
              <KeyVal
                label="Cert networks"
                value={(certDetails.networks || certDetails.ips || []).join(', ')}
                mono
              />
              <KeyVal label="Expires" value={certDetails.notAfter} mono />
            </VStack>
          ) : null}
          {st.Message ? (
            <Text size="sm" color="$muted500">
              {st.Message}
            </Text>
          ) : null}
        </VStack>
      </Card>

      <Card>
        <SectionHeader title="Network Configuration" />
        <VStack space="md">
          <HStack justifyContent="space-between" alignItems="center">
            <Text size="sm">Enabled</Text>
            <Toggle value={enabled} onPress={() => setEnabled(!enabled)} />
          </HStack>
          <HStack justifyContent="space-between" alignItems="center">
            <Text size="sm">Run as lighthouse (this node has a public, forwarded UDP port)</Text>
            <Toggle
              value={lighthouseMode}
              onPress={() => setLighthouseMode(!lighthouseMode)}
            />
          </HStack>
          <TextField
            label="Overlay network CIDR"
            value={cidr}
            onChangeText={setCidr}
            placeholder="192.168.100.0/24"
            helper="Default prefix for issued certificates"
          />
          <TextField
            label="UDP listen port"
            value={listenPort}
            onChangeText={setListenPort}
            placeholder="4242"
            helper="Listens inside the container network. For inbound connectivity (lighthouse/relay) add an SPR UDP port forward to this container."
          />
          {!lighthouseMode ? (
            <TextField
              label="Lighthouse overlay IPs"
              value={lighthouses}
              onChangeText={setLighthouses}
              placeholder="192.168.100.1, 192.168.100.2"
              helper="Comma separated. Each must also have a static host map entry below."
            />
          ) : null}
          <TextField
            label="Relays (overlay IPs)"
            value={relays}
            onChangeText={setRelays}
            placeholder="192.168.100.1"
            helper="Optional comma separated list of relay nodes to use"
          />
          <HStack justifyContent="space-between" alignItems="center">
            <Text size="sm">Punchy: punch (keep NAT mappings alive)</Text>
            <Toggle value={punch} onPress={() => setPunch(!punch)} />
          </HStack>
          <HStack justifyContent="space-between" alignItems="center">
            <Text size="sm">Punchy: respond (punch back on failed tunnels)</Text>
            <Toggle value={punchRespond} onPress={() => setPunchRespond(!punchRespond)} />
          </HStack>
          <HStack justifyContent="space-between" alignItems="center">
            <Text size="sm">Use relays learned from lighthouses</Text>
            <Toggle value={useRelays} onPress={() => setUseRelays(!useRelays)} />
          </HStack>
          <HStack justifyContent="space-between" alignItems="center">
            <Text size="sm">Act as a relay for other nodes</Text>
            <Toggle value={amRelay} onPress={() => setAmRelay(!amRelay)} />
          </HStack>
          <HStack justifyContent="space-between" alignItems="center">
            <Text size="sm">Allow inbound ICMP (ping) from overlay hosts</Text>
            <Toggle value={allowICMP} onPress={() => setAllowICMP(!allowICMP)} />
          </HStack>
        </VStack>
      </Card>

      <Card>
        <SectionHeader title="Static Host Map" count={hostMap.length} />
        <VStack space="md">
          <Text size="sm" color="$muted500">
            Maps overlay IPs to real-world addresses. Lighthouses must be listed
            here.
          </Text>
          {hostMap.map((row, idx) => (
            <HStack key={idx} space="sm" alignItems="flex-end" flexWrap="wrap">
              <TextField
                label="Overlay IP"
                value={row.ip}
                onChangeText={(v) =>
                  setHostMap(hostMap.map((r, i) => (i === idx ? { ...r, ip: v } : r)))
                }
                placeholder="192.168.100.1"
              />
              <TextField
                label="Public endpoints (host:port, comma separated)"
                value={row.endpoints}
                onChangeText={(v) =>
                  setHostMap(
                    hostMap.map((r, i) => (i === idx ? { ...r, endpoints: v } : r))
                  )
                }
                placeholder="lighthouse.example.com:4242"
              />
              <Button
                size="xs"
                variant="outline"
                action="negative"
                onPress={() => setHostMap(hostMap.filter((_, i) => i !== idx))}
              >
                <ButtonText>Remove</ButtonText>
              </Button>
            </HStack>
          ))}
          <HStack space="sm" alignItems="flex-end" flexWrap="wrap">
            <TextField
              label="Overlay IP"
              value={newMapIP}
              onChangeText={setNewMapIP}
              placeholder="192.168.100.1"
            />
            <TextField
              label="Public endpoints"
              value={newMapEndpoints}
              onChangeText={setNewMapEndpoints}
              placeholder="203.0.113.9:4242"
            />
            <Button
              size="xs"
              variant="outline"
              onPress={() => {
                if (!newMapIP.trim().length) return
                setHostMap([...hostMap, { ip: newMapIP, endpoints: newMapEndpoints }])
                setNewMapIP('')
                setNewMapEndpoints('')
              }}
            >
              <ButtonText>Add</ButtonText>
            </Button>
          </HStack>
          <Text size="xs" color="$muted500">
            Changes take effect after Save.
          </Text>
        </VStack>
      </Card>

      <Card>
        <SectionHeader
          title="Certificate Authority"
          right={<StatusDot online={caConfigured} />}
        />
        <VStack space="md">
          {!caConfigured ? (
            <>
              <TextField
                label="CA name"
                value={caName}
                onChangeText={setCaName}
                placeholder="SPR Nebula CA"
                helper="The CA private key is generated on the router (0600 in /configs) and can never be downloaded."
              />
              <Button size="sm" onPress={() => createCA(false)}>
                <ButtonText>Create CA</ButtonText>
              </Button>
            </>
          ) : (
            <>
              <KeyVal label="CA" value="configured (private key never leaves the router)" />
              <HStack space="sm">
                <Button size="xs" variant="outline" onPress={fetchCA}>
                  <ButtonText>Show CA certificate</ButtonText>
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  action="negative"
                  onPress={() => setShowRegenCA(true)}
                >
                  <ButtonText>Regenerate CA</ButtonText>
                </Button>
              </HStack>
              {caCert ? (
                <PemBlock
                  label="CA certificate (public — distribute to all nodes)"
                  value={caCert}
                  filename="ca.crt"
                  onCopied={() => alert.success('Copied CA certificate')}
                />
              ) : null}
            </>
          )}
        </VStack>
      </Card>

      <Card>
        <SectionHeader
          title="Issue Device Certificate"
          right={<StatusDot online={certConfigured} />}
        />
        <VStack space="md">
          <TextField
            label="Device name"
            value={certName}
            onChangeText={setCertName}
            placeholder="alex-laptop"
          />
          <TextField
            label="Overlay IP"
            value={certIP}
            onChangeText={setCertIP}
            placeholder={cidr ? `e.g. an address in ${cidr}` : '192.168.100.5/24'}
            helper={cidr ? 'Prefix defaults to the network CIDR' : 'Use CIDR notation or set the network CIDR above'}
          />
          <TextField
            label="Groups (optional)"
            value={certGroups}
            onChangeText={setCertGroups}
            placeholder="laptop, home"
            helper="Used by nebula firewall rules on other nodes"
          />
          <HStack justifyContent="space-between" alignItems="center">
            <Text size="sm">Install as this router's identity (key stays on the router)</Text>
            <Toggle value={certInstall} onPress={() => setCertInstall(!certInstall)} />
          </HStack>
          <Button size="sm" onPress={issueCert} isDisabled={!caConfigured}>
            <ButtonText>{certInstall ? 'Issue + install' : 'Issue certificate'}</ButtonText>
          </Button>
          {!caConfigured ? (
            <Text size="xs" color="$muted500">
              Create or import a CA first.
            </Text>
          ) : null}
        </VStack>
      </Card>

      <Card>
        <SectionHeader title="Import Existing Credentials" />
        <VStack space="md">
          <Text size="sm" color="$muted500">
            Join an existing nebula network: paste the network's ca.crt and a
            host certificate + key issued for this router.
          </Text>
          <Text size="sm">CA certificate (ca.crt)</Text>
          <Textarea h={90}>
            <TextareaInput
              value={importCA}
              onChangeText={setImportCA}
              multiline
              placeholder="-----BEGIN NEBULA CERTIFICATE-----"
              fontFamily="monospace"
              fontSize={11}
            />
          </Textarea>
          <Text size="sm">Host certificate (host.crt)</Text>
          <Textarea h={90}>
            <TextareaInput
              value={importCert}
              onChangeText={setImportCert}
              multiline
              placeholder="-----BEGIN NEBULA CERTIFICATE-----"
              fontFamily="monospace"
              fontSize={11}
            />
          </Textarea>
          <TextField
            label="Host private key (host.key)"
            value={importKey}
            onChangeText={setImportKey}
            placeholder="-----BEGIN NEBULA X25519 PRIVATE KEY----- ..."
            helper="Stored 0600 on the router, never displayed again"
            secureTextEntry
          />
          <Button size="sm" onPress={importKeys}>
            <ButtonText>Import</ButtonText>
          </Button>
        </VStack>
      </Card>

      <ModalConfirm
        isOpen={showRegenCA}
        onClose={() => setShowRegenCA(false)}
        onConfirm={() => {
          setShowRegenCA(false)
          createCA(true)
        }}
        title="Regenerate CA?"
        message="This creates a new CA and invalidates every certificate issued by the old one. All devices will need new certificates."
        confirmText="Regenerate"
        destructive
      />

      <ModalForm
        isOpen={!!issued}
        onClose={() => setIssued(null)}
        title={issued && issued.Installed ? 'Certificate installed' : 'Certificate issued'}
      >
        {issued ? (
          <VStack space="md">
            {!issued.Installed && issued.Key ? (
              <Text size="sm" color="$muted500">
                Copy or download the private key now — it is not stored on the
                router and cannot be shown again.
              </Text>
            ) : null}
            <PemBlock
              label="Certificate"
              value={issued.Cert || ''}
              filename={`${certName || 'node'}.crt`}
              onCopied={() => alert.success('Copied certificate')}
            />
            {!issued.Installed && issued.Key ? (
              <PemBlock
                label="Private key (shown once)"
                value={issued.Key}
                filename={`${certName || 'node'}.key`}
                onCopied={() => alert.success('Copied private key')}
              />
            ) : null}
            <Button size="sm" variant="outline" onPress={() => setIssued(null)}>
              <ButtonText>Done</ButtonText>
            </Button>
          </VStack>
        ) : (
          <VStack />
        )}
      </ModalForm>
    </Page>
  )
}
