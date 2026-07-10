import React, { useEffect, useState } from 'react'
import {
  api,
  useAlert,
  timeAgo,
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
  EmptyState,
  Badge,
  BadgeText,
  Box,
  Button,
  ButtonText,
  CheckIcon,
  GlobeIcon,
  HStack,
  Icon,
  Pressable,
  Text,
  Textarea,
  TextareaInput,
  VStack
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

// ---- small fittings -------------------------------------------------------

const TabRow = ({ tabs, active, onChange }) => (
  <HStack
    space="xs"
    p="$1"
    borderRadius="$xl"
    borderWidth={1}
    borderColor="$borderColorCardLight"
    bg="$backgroundCardLight"
    alignSelf="flex-start"
    flexWrap="wrap"
    sx={{
      _dark: { bg: '$backgroundCardDark', borderColor: '$borderColorCardDark' }
    }}
  >
    {tabs.map((t) => {
      const selected = t.key === active
      return (
        <Pressable key={t.key} onPress={() => onChange(t.key)}>
          <Box
            px="$3"
            py="$1.5"
            borderRadius="$lg"
            bg={selected ? '$primary600' : 'transparent'}
            sx={{ _dark: { bg: selected ? '$primary500' : 'transparent' } }}
          >
            <Text
              size="sm"
              fontWeight="$medium"
              color={selected ? '$white' : '$muted500'}
            >
              {t.label}
            </Text>
          </Box>
        </Pressable>
      )
    })}
  </HStack>
)

const ToggleRow = ({ label, description, value, onPress, disabled }) => (
  <HStack justifyContent="space-between" alignItems="center" space="md">
    <VStack flexShrink={1}>
      <Text size="sm" color="$textLight900" sx={{ _dark: { color: '$textDark100' } }}>
        {label}
      </Text>
      {description ? (
        <Text size="xs" color="$muted500">
          {description}
        </Text>
      ) : null}
    </VStack>
    <Toggle value={value} onPress={onPress} disabled={disabled} label={label} />
  </HStack>
)

const StepRow = ({ n, done, title, description, children }) => (
  <HStack space="md" alignItems="flex-start">
    <Box
      w={28}
      h={28}
      flexShrink={0}
      borderRadius="$full"
      alignItems="center"
      justifyContent="center"
      bg={done ? '$green500' : 'transparent'}
      borderWidth={done ? 0 : 1}
      borderColor="$muted300"
      sx={{ _dark: { borderColor: '$muted700' } }}
    >
      {done ? (
        <Icon as={CheckIcon} color="$white" size="sm" />
      ) : (
        <Text size="sm" color="$muted500" fontWeight="$medium">
          {n}
        </Text>
      )}
    </Box>
    <VStack space="xs" flex={1}>
      <Text
        size="sm"
        fontWeight="$semibold"
        color="$textLight900"
        sx={{ _dark: { color: '$textDark100' } }}
      >
        {title}
      </Text>
      <Text size="sm" color="$muted500">
        {description}
      </Text>
      {!done && children ? (
        <HStack space="sm" mt="$1" flexWrap="wrap">
          {children}
        </HStack>
      ) : null}
    </VStack>
  </HStack>
)

const ConfiguredChip = ({ ok, label }) => (
  <Badge action={ok ? 'success' : 'muted'} variant="outline" borderRadius="$full">
    <BadgeText>{ok ? `${label}: configured ✓` : `${label}: not set`}</BadgeText>
  </Badge>
)

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

const PemInput = ({ label, value, onChangeText, placeholder }) => (
  <VStack space="xs">
    <Text size="sm" fontWeight="$semibold" color="$textLight800" sx={{ _dark: { color: '$textDark100' } }}>
      {label}
    </Text>
    <Textarea h={90}>
      <TextareaInput
        value={value}
        onChangeText={onChangeText}
        multiline
        placeholder={placeholder}
        fontFamily="monospace"
        fontSize={11}
      />
    </Textarea>
  </VStack>
)

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'network', label: 'Network' },
  { key: 'certs', label: 'Certificates' },
  { key: 'import', label: 'Import' }
]

export default function Plugin() {
  const alert = useAlert()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [status, setStatus] = useState(null)
  const [tab, setTab] = useState('overview')
  const [caConfigured, setCAConfigured] = useState(false)
  const [certConfigured, setCertConfigured] = useState(false)

  // network form state
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
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)

  // static host map editor
  const [newMapIP, setNewMapIP] = useState('')
  const [newMapEndpoints, setNewMapEndpoints] = useState('')
  const [newMapError, setNewMapError] = useState('')
  const [removeIdx, setRemoveIdx] = useState(null)

  // CA / cert state
  const [caName, setCaName] = useState('SPR Nebula CA')
  const [caCert, setCaCert] = useState('')
  const [creatingCA, setCreatingCA] = useState(false)
  const [showRegenCA, setShowRegenCA] = useState(false)
  const [certName, setCertName] = useState('')
  const [certIP, setCertIP] = useState('')
  const [certGroups, setCertGroups] = useState('')
  const [certErrors, setCertErrors] = useState({})
  const [issuing, setIssuing] = useState(false)
  const [routerName, setRouterName] = useState('')
  const [routerIP, setRouterIP] = useState('')
  const [routerGroups, setRouterGroups] = useState('')
  const [routerErrors, setRouterErrors] = useState({})
  const [installing, setInstalling] = useState(false)
  const [showRouterIdentityForm, setShowRouterIdentityForm] = useState(false)
  const [showInstallConfirm, setShowInstallConfirm] = useState(false)
  const [issued, setIssued] = useState(null) // {Cert, Key, Installed, RequestedName}
  const [ackKeySaved, setAckKeySaved] = useState(false)

  // import state
  const [importCA, setImportCA] = useState('')
  const [importCert, setImportCert] = useState('')
  const [importKey, setImportKey] = useState('')
  const [importing, setImporting] = useState(false)

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
    setDirty(false)
  }

  const refresh = () => {
    Promise.all([
      api.get(`${PLUGIN_BASE}/config`),
      api.get(`${PLUGIN_BASE}/status`)
    ])
      .then(([c, s]) => {
        applyConfig(c)
        setStatus(s)
        setLoadError(false)
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false))
  }

  const refreshStatus = () => {
    api
      .get(`${PLUGIN_BASE}/status`)
      .then((s) => {
        setStatus(s)
        // Config is authoritative. Only accept the derived status flags when
        // they are actually present, so a legacy/string response cannot erase
        // known credential state.
        if (s && typeof s.CAConfigured === 'boolean') {
          setCAConfigured(s.CAConfigured)
        }
        if (s && typeof s.CertConfigured === 'boolean') {
          setCertConfigured(s.CertConfigured)
        }
      })
      .catch(() => {})
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refreshStatus, 15000)
    return () => clearInterval(t)
  }, [])

  // wraps a setter so edits mark the network form dirty
  const edit = (setter) => (v) => {
    setter(v)
    setDirty(true)
  }

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
    setSaving(true)
    api
      .put(`${PLUGIN_BASE}/config`, buildConfig())
      .then((c) => {
        applyConfig(c)
        alert.success('Configuration saved')
        refreshStatus()
      })
      .catch((err) => alert.error('Failed to save', err))
      .finally(() => setSaving(false))
  }

  const restart = () => {
    setRestarting(true)
    api
      .post(`${PLUGIN_BASE}/restart`, {})
      .then(() => {
        alert.success('Nebula restarted')
        refreshStatus()
      })
      .catch((err) => alert.error('Restart failed', err))
      .finally(() => setRestarting(false))
  }

  const createCA = (force) => {
    setCreatingCA(true)
    api
      .post(`${PLUGIN_BASE}/ca`, { Name: caName, Force: !!force })
      .then((res) => {
        setCaCert(res.CACert || '')
        setCAConfigured(true)
        alert.success('CA created — the private key stays on the router')
        refreshStatus()
      })
      .catch((err) => {
        if (err && err.status === 409 && !force) {
          return Promise.all([
            api.get(`${PLUGIN_BASE}/config`),
            api.get(`${PLUGIN_BASE}/ca`)
          ])
            .then(([config, ca]) => {
              if (!config.CAConfigured) throw err
              setCAConfigured(true)
              setCaCert(ca.CACert || '')
              alert.info('CA already configured — using the existing CA')
            })
            .catch((recoveryErr) => alert.error('Failed to create CA', recoveryErr))
        }
        alert.error('Failed to create CA', err)
      })
      .finally(() => setCreatingCA(false))
  }

  const fetchCA = () => {
    api
      .get(`${PLUGIN_BASE}/ca`)
      .then((res) => setCaCert(res.CACert || ''))
      .catch((err) => alert.error('Failed to fetch CA certificate', err))
  }

  const validateCertForm = () => {
    const errs = {}
    if (!certName.trim().length) {
      errs.name = 'Device name is required'
    }
    if (!certIP.trim().length) {
      errs.ip = cidr
        ? `Pick an address inside ${cidr}`
        : 'Overlay IP is required (CIDR notation, e.g. 192.168.100.5/24)'
    }
    setCertErrors(errs)
    return Object.keys(errs).length === 0
  }

  const validateRouterForm = () => {
    const errs = {}
    if (!routerName.trim().length) {
      errs.name = 'Router name is required'
    }
    if (!routerIP.trim().length) {
      errs.ip = cidr
        ? `Pick this router's address inside ${cidr}`
        : 'Router overlay IP is required (CIDR notation, e.g. 192.168.100.1/24)'
    }
    setRouterErrors(errs)
    return Object.keys(errs).length === 0
  }

  const submitCert = ({ name, ip, groups, install }) => {
    const setBusy = install ? setInstalling : setIssuing
    setBusy(true)
    api
      .post(`${PLUGIN_BASE}/certs`, {
        Name: name.trim(),
        IP: ip.trim(),
        Groups: csv(groups),
        Install: !!install
      })
      .then((res) => {
        setAckKeySaved(false)
        setIssued({ ...res, RequestedName: name.trim() })
        if (res.Installed) {
          alert.success("This router's Nebula identity was installed")
          setCertConfigured(true)
          refreshStatus()
        }
      })
      .catch((err) => alert.error('Failed to issue certificate', err))
      .finally(() => setBusy(false))
  }

  const issueDeviceCert = () => {
    if (!validateCertForm()) return
    submitCert({
      name: certName,
      ip: certIP,
      groups: certGroups,
      install: false
    })
  }

  const installRouterIdentity = () => {
    if (!validateRouterForm()) return
    setShowRouterIdentityForm(false)
    submitCert({
      name: routerName,
      ip: routerIP,
      groups: routerGroups,
      install: true
    })
  }

  const openRouterIdentityForm = () => {
    const currentNetworks = (certDetails && (certDetails.networks || certDetails.ips)) || []
    const currentGroups = (certDetails && certDetails.groups) || []
    if (!routerName) setRouterName((certDetails && certDetails.name) || 'spr-router')
    if (!routerIP && currentNetworks.length) setRouterIP(currentNetworks[0])
    if (!routerGroups && currentGroups.length) setRouterGroups(currentGroups.join(', '))
    setRouterErrors({})
    setShowRouterIdentityForm(true)
  }

  const importKeys = () => {
    setImporting(true)
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
      .finally(() => setImporting(false))
  }

  const addHostMapEntry = () => {
    const ip = newMapIP.trim()
    if (!ip.length) {
      setNewMapError('Overlay IP is required')
      return
    }
    if (hostMap.some((r) => r.ip.trim() === ip)) {
      setNewMapError(`${ip} is already mapped`)
      return
    }
    if (!csv(newMapEndpoints).length) {
      setNewMapError('At least one host:port endpoint is required')
      return
    }
    setNewMapError('')
    setHostMap([...hostMap, { ip, endpoints: newMapEndpoints }])
    setNewMapIP('')
    setNewMapEndpoints('')
    setDirty(true)
  }

  // ---- derived state ------------------------------------------------------

  const st = status || {}
  const running = !!st.Running
  const ifaceUp = !!st.InterfaceUp
  const certDetails = (() => {
    let ci = st.CertInfo
    if (Array.isArray(ci)) ci = ci[0]
    return (ci && ci.details) || null
  })()
  const overlayIP = (st.InterfaceIPs || []).join(' ')
  const lighthouseSet = new Set(csv(lighthouses))
  const lighthouseReady = lighthouseMode || lighthouseSet.size > 0
  const setupNeeded = !certConfigured

  let statusWord = 'Stopped'
  let statusAction = 'warning'
  if (!enabled) {
    statusWord = 'Disabled'
    statusAction = 'muted'
  } else if (running && ifaceUp) {
    statusWord = 'Connected'
    statusAction = 'success'
  } else if (running) {
    statusWord = 'Starting'
  }

  const removeTarget = removeIdx != null ? hostMap[removeIdx] : null
  const removeIsLighthouse = removeTarget && lighthouseSet.has(removeTarget.ip.trim())

  // ---- top-level loading / error states ------------------------------------

  if (loading) {
    return (
      <Page>
        <Loading text="Loading nebula plugin..." />
      </Page>
    )
  }

  if (loadError) {
    return (
      <Page>
        <ListHeader title="Nebula" description="Overlay mesh network (slackhq/nebula)" mark="nb" />
        <Card>
          <EmptyState
            icon={GlobeIcon}
            title="Can't reach the nebula plugin"
            description="The plugin backend did not respond. It may still be starting, or its container may be stopped."
          >
            <Button
              size="sm"
              onPress={() => {
                setLoading(true)
                refresh()
              }}
            >
              <ButtonText>Retry</ButtonText>
            </Button>
          </EmptyState>
        </Card>
      </Page>
    )
  }

  // ---- tab contents ---------------------------------------------------------

  const overviewTab = (
    <>
      {setupNeeded ? (
        <Card>
          <SectionHeader title="Set up your overlay network" />
          <VStack space="lg">
            <Text size="sm" color="$muted500">
              Nebula needs a certificate authority and an identity certificate
              for this router before it can join — or start — an overlay
              network.
            </Text>
            <StepRow
              n={1}
              done={caConfigured}
              title="Create a CA (or import one)"
              description="Generate a certificate authority on this router — its private key never leaves the device. Joining an existing network? Import its credentials instead."
            >
              <Button size="xs" onPress={() => setTab('certs')}>
                <ButtonText>Create a CA</ButtonText>
              </Button>
              <Button size="xs" variant="outline" onPress={() => setTab('import')}>
                <ButtonText>Import existing</ButtonText>
              </Button>
            </StepRow>
            <StepRow
              n={2}
              done={certConfigured}
              title="Issue the router's certificate"
              description="Sign a certificate with an overlay IP and install it as this router's identity."
            >
              <Button size="xs" isDisabled={!caConfigured} onPress={() => setTab('certs')}>
                <ButtonText>Issue certificate</ButtonText>
              </Button>
            </StepRow>
            <StepRow
              n={3}
              done={lighthouseReady}
              title="Configure lighthouse"
              description="Point this node at a lighthouse — or run this router as one — so peers can find each other, then enable nebula."
            >
              <Button size="xs" variant="outline" onPress={() => setTab('network')}>
                <ButtonText>Open network settings</ButtonText>
              </Button>
            </StepRow>
            {st.Message ? (
              <Text size="xs" color="$muted500">
                {st.Message}
              </Text>
            ) : null}
          </VStack>
        </Card>
      ) : (
        <Card>
          <SectionHeader
            title="Overview"
            right={<StatusDot online={running && ifaceUp} warn={running && !ifaceUp} />}
          />
          <VStack space="lg">
            <HStack space="xl" flexWrap="wrap">
              <HStack space="sm" alignItems="center" minWidth={200}>
                <StatusDot online={running && ifaceUp} warn={running && !ifaceUp} />
                <VStack>
                  <Text size="sm" fontWeight="$semibold" color="$textLight900" sx={{ _dark: { color: '$textDark50' } }}>
                    {statusWord}
                  </Text>
                  <Text size="xs" color="$muted500">
                    Nebula daemon
                  </Text>
                </VStack>
              </HStack>
              <HStack space="sm" alignItems="center" minWidth={200}>
                <StatusDot online={certConfigured} />
                <VStack>
                  <Text size="sm" fontWeight="$semibold" color="$textLight900" sx={{ _dark: { color: '$textDark50' } }}>
                    {certConfigured ? (certDetails && certDetails.name) || 'Installed' : 'Not installed'}
                  </Text>
                  <Text size="xs" color="$muted500">
                    Router certificate
                  </Text>
                </VStack>
              </HStack>
            </HStack>

            <HStack flexWrap="wrap" gap="$2">
              <StatTile label="Mode" value={st.Mode === 'lighthouse' ? 'Lighthouse' : 'Node'} />
              <StatTile label="UDP port" value={String(st.ListenPort ?? '—')} mono />
              {st.NebulaVersion ? <StatTile label="Version" value={st.NebulaVersion} mono /> : null}
              <StatTile
                label="Interface"
                value={`${st.InterfaceName || 'nebula1'} ${ifaceUp ? 'up' : 'down'}`}
                mono
              />
              <StatTile label="Overlay IP" value={overlayIP || '—'} mono />
              <StatTile label="Started" value={(st.StartedAt && timeAgo(st.StartedAt)) || '—'} />
            </HStack>

            {overlayIP ? (
              <HStack space="sm" alignItems="center">
                <Text size="sm" color="$muted500" minWidth={132}>
                  Overlay IP
                </Text>
                <Text size="sm" fontFamily="monospace">
                  {overlayIP}
                </Text>
                <Button
                  size="xs"
                  variant="link"
                  onPress={() => copyText(overlayIP).then(() => alert.success('Copied overlay IP'))}
                >
                  <ButtonText>Copy</ButtonText>
                </Button>
              </HStack>
            ) : null}

            {certDetails ? (
              <VStack space="xs">
                <KeyVal
                  label="Cert networks"
                  value={(certDetails.networks || certDetails.ips || []).join(', ')}
                  mono
                />
                <KeyVal label="Cert expires" value={certDetails.notAfter} mono />
              </VStack>
            ) : null}

            {st.Mode !== 'lighthouse' ? (
              <VStack space="sm">
                {(st.Lighthouses || []).map((lh) => (
                  <HStack key={lh.Host} space="sm" alignItems="center">
                    <StatusDot online={lh.Reachable} />
                    <Text size="sm" fontFamily="monospace">
                      {lh.Host}
                    </Text>
                    <Text size="sm" color="$muted500">
                      {lh.Reachable ? 'Lighthouse reachable' : 'Lighthouse unreachable'}
                    </Text>
                  </HStack>
                ))}
                {!(st.Lighthouses || []).length && running ? (
                  <Text size="xs" color="$muted500">
                    {lighthouseSet.size
                      ? 'Lighthouse reachability is checked once the overlay interface is up.'
                      : 'No lighthouses configured — add one on the Network tab so peers can find this node.'}
                  </Text>
                ) : null}
              </VStack>
            ) : (
              <Text size="xs" color="$muted500">
                This router is a lighthouse — remote nodes reach it on UDP port{' '}
                {String(st.ListenPort ?? '')} (add an SPR UDP port forward to the
                container).
              </Text>
            )}

            {st.Message ? (
              <Text size="sm" color="$muted500">
                {st.Message}
              </Text>
            ) : null}
          </VStack>
        </Card>
      )}
    </>
  )

  const networkTab = (
    <>
      <Card>
        <SectionHeader title="Network configuration" />
        <VStack space="md">
          <ToggleRow
            label="Enable nebula"
            description="Run the nebula daemon on this router"
            value={enabled}
            onPress={() => edit(setEnabled)(!enabled)}
          />
          <ToggleRow
            label="Run as lighthouse"
            description="This node has a public, forwarded UDP port and helps peers discover each other"
            value={lighthouseMode}
            onPress={() => edit(setLighthouseMode)(!lighthouseMode)}
          />
          <TextField
            label="Overlay network CIDR"
            value={cidr}
            onChangeText={edit(setCidr)}
            placeholder="192.168.100.0/24"
            helper="Default prefix for issued certificates"
          />
          <TextField
            label="UDP listen port"
            value={listenPort}
            onChangeText={edit(setListenPort)}
            placeholder="4242"
            helper="Listens inside the container network. For inbound connectivity (lighthouse/relay) add an SPR UDP port forward to this container."
          />
          {!lighthouseMode ? (
            <TextField
              label="Lighthouse overlay IPs"
              value={lighthouses}
              onChangeText={edit(setLighthouses)}
              placeholder="192.168.100.1, 192.168.100.2"
              helper="Comma separated. Each lighthouse also needs a static host map entry below."
            />
          ) : null}
          <TextField
            label="Relays (overlay IPs)"
            value={relays}
            onChangeText={edit(setRelays)}
            placeholder="192.168.100.1"
            helper="Optional comma separated list of relay nodes to use"
          />
          <ToggleRow
            label="Punchy: punch"
            description="Keep NAT mappings alive"
            value={punch}
            onPress={() => edit(setPunch)(!punch)}
          />
          <ToggleRow
            label="Punchy: respond"
            description="Punch back when a tunnel fails to establish"
            value={punchRespond}
            onPress={() => edit(setPunchRespond)(!punchRespond)}
          />
          <ToggleRow
            label="Use learned relays"
            description="Use relays advertised by the lighthouses"
            value={useRelays}
            onPress={() => edit(setUseRelays)(!useRelays)}
          />
          <ToggleRow
            label="Act as a relay"
            description="Forward traffic for overlay nodes that cannot connect directly"
            value={amRelay}
            onPress={() => edit(setAmRelay)(!amRelay)}
          />
          <ToggleRow
            label="Allow inbound ICMP"
            description="Let overlay hosts ping this router (inbound is deny-all by default)"
            value={allowICMP}
            onPress={() => edit(setAllowICMP)(!allowICMP)}
          />
          <HStack justifyContent="space-between" alignItems="center" mt="$2">
            <Text size="xs" color="$muted500" flexShrink={1}>
              Saving applies immediately — when enabled, nebula restarts with
              the new configuration.
            </Text>
            <Button size="sm" onPress={save} isDisabled={!dirty || saving}>
              <ButtonText>{saving ? 'Saving…' : 'Save changes'}</ButtonText>
            </Button>
          </HStack>
        </VStack>
      </Card>

      <Card>
        <SectionHeader title="Static host map" count={hostMap.length} />
        <VStack space="md">
          {hostMap.length ? (
            <VStack>
              {hostMap.map((row, idx) => {
                const ip = row.ip.trim()
                return (
                  <HStack
                    key={`${ip}-${idx}`}
                    justifyContent="space-between"
                    alignItems="center"
                    space="md"
                    py="$2"
                    borderBottomWidth={idx < hostMap.length - 1 ? 1 : 0}
                    borderColor="$borderColorCardLight"
                    sx={{ _dark: { borderColor: '$borderColorCardDark' } }}
                  >
                    <VStack flexShrink={1}>
                      <HStack space="sm" alignItems="center">
                        <Text size="sm" fontWeight="$semibold" fontFamily="monospace">
                          {ip}
                        </Text>
                        {lighthouseSet.has(ip) ? (
                          <Badge action="info" variant="outline" borderRadius="$full" size="sm">
                            <BadgeText>lighthouse</BadgeText>
                          </Badge>
                        ) : null}
                      </HStack>
                      <Text size="xs" color="$muted500" fontFamily="monospace">
                        {csv(row.endpoints).join('  ') || '—'}
                      </Text>
                    </VStack>
                    <Button size="xs" variant="link" action="negative" onPress={() => setRemoveIdx(idx)}>
                      <ButtonText>Remove</ButtonText>
                    </Button>
                  </HStack>
                )
              })}
            </VStack>
          ) : (
            <EmptyState
              icon={GlobeIcon}
              title="No static hosts mapped"
              description="Static host map entries tell this node the real-world address of an overlay IP. Every lighthouse must be listed here."
            />
          )}
          <HStack space="sm" alignItems="flex-start" flexWrap="wrap">
            <Box flexGrow={1} minWidth={160}>
              <TextField
                label="Overlay IP"
                value={newMapIP}
                onChangeText={setNewMapIP}
                placeholder="192.168.100.1"
                error={newMapError || undefined}
              />
            </Box>
            <Box flexGrow={2} minWidth={220}>
              <TextField
                label="Public endpoints"
                value={newMapEndpoints}
                onChangeText={setNewMapEndpoints}
                placeholder="lighthouse.example.com:4242, 203.0.113.9:4242"
                helper="host:port, comma separated"
              />
            </Box>
            <Box pt={26}>
              <Button size="sm" variant="outline" onPress={addHostMapEntry}>
                <ButtonText>Add entry</ButtonText>
              </Button>
            </Box>
          </HStack>
          <Text size="xs" color="$muted500">
            Entries apply after you save the network configuration.
          </Text>
        </VStack>
      </Card>
    </>
  )

  const certsTab = (
    <>
      <Card>
        <SectionHeader
          title="Certificate authority"
          right={<ConfiguredChip ok={caConfigured} label="CA" />}
        />
        <VStack space="md">
          {!caConfigured ? (
            <>
              <Text size="sm" color="$muted500">
                The CA signs every certificate on your overlay network. Its
                private key is generated on the router (stored 0600) and can
                never be downloaded.
              </Text>
              <TextField
                label="CA name"
                value={caName}
                onChangeText={setCaName}
                placeholder="SPR Nebula CA"
              />
              <HStack space="sm" alignItems="center">
                <Button size="sm" onPress={() => createCA(false)} isDisabled={creatingCA}>
                  <ButtonText>{creatingCA ? 'Creating…' : 'Create CA'}</ButtonText>
                </Button>
                <Text size="xs" color="$muted500">
                  Joining an existing network? Use the Import tab instead.
                </Text>
              </HStack>
            </>
          ) : (
            <>
              <KeyVal label="CA private key" value="Stored on the router — never leaves the device" />
              <HStack space="sm">
                <Button size="xs" variant="outline" onPress={() => (caCert ? setCaCert('') : fetchCA())}>
                  <ButtonText>{caCert ? 'Hide CA certificate' : 'Show CA certificate'}</ButtonText>
                </Button>
                <Button size="xs" variant="outline" action="negative" onPress={() => setShowRegenCA(true)}>
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
          title="This router's identity"
          right={<ConfiguredChip ok={certConfigured} label="Router identity" />}
        />
        <VStack space="md">
          <Text size="sm" color="$muted500">
            This certificate identifies the SPR router itself as one Nebula
            node. It is separate from certificates issued to laptops, phones,
            servers, and other devices.
          </Text>
          {certConfigured && certDetails ? (
            <VStack space="xs">
              <KeyVal label="Router name" value={certDetails.name || '—'} mono />
              <KeyVal
                label="Router overlay IP"
                value={(certDetails.networks || certDetails.ips || []).join(', ') || '—'}
                mono
              />
            </VStack>
          ) : null}
          <HStack space="sm" alignItems="center" flexWrap="wrap">
            <Button
              size="sm"
              variant={certConfigured ? 'outline' : 'solid'}
              action={certConfigured ? 'negative' : 'primary'}
              onPress={openRouterIdentityForm}
              isDisabled={!caConfigured || installing || issuing}
            >
              <ButtonText>
                {installing
                  ? 'Installing…'
                  : certConfigured
                    ? 'Replace router identity…'
                    : 'Set up router identity…'}
              </ButtonText>
            </Button>
            {!caConfigured ? (
              <Text size="xs" color="$muted500">Create or import a CA first.</Text>
            ) : null}
          </HStack>
        </VStack>
      </Card>

      <Card>
        <SectionHeader title="Certificates for other devices" />
        <VStack space="md">
          <Text size="sm" color="$muted500">
            Issue credentials for a laptop, phone, server, or another Nebula
            node. This does not change this router's identity.
          </Text>
          <TextField
            label="Device name"
            value={certName}
            onChangeText={(v) => {
              setCertName(v)
              if (certErrors.name) setCertErrors({ ...certErrors, name: '' })
            }}
            placeholder="alex-laptop"
            error={certErrors.name || undefined}
          />
          <TextField
            label="Overlay IP"
            value={certIP}
            onChangeText={(v) => {
              setCertIP(v)
              if (certErrors.ip) setCertErrors({ ...certErrors, ip: '' })
            }}
            placeholder={cidr ? `e.g. an address in ${cidr}` : '192.168.100.5/24'}
            helper={
              cidr
                ? `Use this device's unique host address inside ${cidr}; the prefix defaults from the network CIDR`
                : 'Use CIDR notation, or set the network CIDR on the Network tab'
            }
            error={certErrors.ip || undefined}
          />
          <TextField
            label="Groups (optional)"
            value={certGroups}
            onChangeText={setCertGroups}
            placeholder="laptop, home"
            helper="Used by nebula firewall rules on other nodes"
          />
          <Button
            size="sm"
            alignSelf="flex-start"
            onPress={issueDeviceCert}
            isDisabled={!caConfigured || issuing || installing}
          >
            <ButtonText>{issuing ? 'Issuing…' : 'Issue device certificate'}</ButtonText>
          </Button>
          <Text size="xs" color="$muted500">
            {caConfigured
              ? 'The certificate and private key are shown once. Save both on the named device; its private key is not stored on this router.'
              : 'Create or import a CA first.'}
          </Text>
        </VStack>
      </Card>
    </>
  )

  const importTab = (
    <Card>
      <SectionHeader
        title="Import existing credentials"
        right={
          <HStack space="sm">
            <ConfiguredChip ok={caConfigured} label="CA" />
            <ConfiguredChip ok={certConfigured} label="Identity" />
          </HStack>
        }
      />
      <VStack space="md">
        <Text size="sm" color="$muted500">
          Join an existing nebula network: paste the network's ca.crt and a host
          certificate + key issued for this router. Importing replaces the
          matching credentials currently on the router.
        </Text>
        <PemInput
          label="CA certificate (ca.crt)"
          value={importCA}
          onChangeText={setImportCA}
          placeholder="-----BEGIN NEBULA CERTIFICATE-----"
        />
        <PemInput
          label="Host certificate (host.crt)"
          value={importCert}
          onChangeText={setImportCert}
          placeholder="-----BEGIN NEBULA CERTIFICATE-----"
        />
        <TextField
          label="Host private key (host.key)"
          value={importKey}
          onChangeText={setImportKey}
          placeholder="-----BEGIN NEBULA X25519 PRIVATE KEY----- ..."
          helper="Stored 0600 on the router, never displayed again. Certificate and key must be imported together."
          secureTextEntry
        />
        <HStack justifyContent="flex-end">
          <Button
            size="sm"
            onPress={importKeys}
            isDisabled={importing || (!importCA.trim() && !importCert.trim() && !importKey.trim())}
          >
            <ButtonText>{importing ? 'Importing…' : 'Import credentials'}</ButtonText>
          </Button>
        </HStack>
      </VStack>
    </Card>
  )

  // ---- page -----------------------------------------------------------------

  const keyPending = issued && !issued.Installed && !!issued.Key
  const closeIssuedModal = () => {
    if (keyPending && !ackKeySaved) return
    setIssued(null)
    setAckKeySaved(false)
  }

  return (
    <Page>
      <ListHeader
        title="Nebula"
        description="Overlay mesh network (slackhq/nebula)"
        mark="nb"
        status={statusWord}
        statusAction={statusAction}
      >
        <Button size="sm" variant="outline" onPress={restart} isDisabled={!st.Enabled || restarting}>
          <ButtonText>{restarting ? 'Restarting…' : 'Restart'}</ButtonText>
        </Button>
      </ListHeader>

      <TabRow tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'overview' ? overviewTab : null}
      {tab === 'network' ? networkTab : null}
      {tab === 'certs' ? certsTab : null}
      {tab === 'import' ? importTab : null}

      <ModalConfirm
        isOpen={showRegenCA}
        onClose={() => setShowRegenCA(false)}
        onConfirm={() => {
          setShowRegenCA(false)
          createCA(true)
        }}
        title="Regenerate the CA?"
        message="A new CA replaces the current one, and every certificate issued by the old CA stops validating — all devices, including this router, need new certificates before they can connect again."
        confirmText="Regenerate CA"
        destructive
      />

      <ModalForm
        isOpen={showRouterIdentityForm}
        onClose={() => setShowRouterIdentityForm(false)}
        title={certConfigured ? 'Replace this router identity' : 'Set up this router identity'}
      >
        <VStack space="md" pb="$2">
          <Text size="sm" color="$muted500">
            These values belong to this SPR router—not to another device. The
            generated private key stays on the router and Nebula restarts with
            the new identity.
          </Text>
          <TextField
            label="Router name"
            value={routerName}
            onChangeText={(v) => {
              setRouterName(v)
              if (routerErrors.name) setRouterErrors({ ...routerErrors, name: '' })
            }}
            placeholder="spr-router"
            error={routerErrors.name || undefined}
          />
          <TextField
            label="Router overlay IP"
            value={routerIP}
            onChangeText={(v) => {
              setRouterIP(v)
              if (routerErrors.ip) setRouterErrors({ ...routerErrors, ip: '' })
            }}
            placeholder={cidr ? `e.g. this router's address in ${cidr}` : '192.168.100.1/24'}
            helper={
              cidr
                ? `Use this router's unique host address inside ${cidr}; the prefix defaults from the network CIDR`
                : 'Use CIDR notation, or set the network CIDR on the Network tab'
            }
            error={routerErrors.ip || undefined}
          />
          <TextField
            label="Router groups (optional)"
            value={routerGroups}
            onChangeText={setRouterGroups}
            placeholder="router, lighthouse"
            helper="Groups assigned only to this SPR router"
          />
          <HStack justifyContent="flex-end">
            <Button
              size="sm"
              action={certConfigured ? 'negative' : 'primary'}
              onPress={() => {
                if (!validateRouterForm()) return
                if (certConfigured) {
                  setShowRouterIdentityForm(false)
                  setShowInstallConfirm(true)
                } else {
                  installRouterIdentity()
                }
              }}
              isDisabled={installing}
            >
              <ButtonText>
                {installing
                  ? 'Installing…'
                  : certConfigured
                    ? 'Review replacement…'
                    : 'Install router identity'}
              </ButtonText>
            </Button>
          </HStack>
        </VStack>
      </ModalForm>

      <ModalConfirm
        isOpen={showInstallConfirm}
        onClose={() => setShowInstallConfirm(false)}
        onConfirm={installRouterIdentity}
        title="Replace this router's identity?"
        message={`The current router certificate and key are overwritten with a new identity for "${routerName.trim()}", and Nebula restarts. This does not affect certificates already issued to other devices.`}
        confirmText="Replace identity"
        destructive
      />

      <ModalConfirm
        isOpen={removeIdx != null}
        onClose={() => setRemoveIdx(null)}
        onConfirm={() => {
          setHostMap(hostMap.filter((_, i) => i !== removeIdx))
          setRemoveIdx(null)
          setDirty(true)
        }}
        title={removeTarget ? `Remove ${removeTarget.ip.trim()} from the host map?` : 'Remove entry?'}
        message={
          removeTarget
            ? `This node will no longer know a real-world address for ${removeTarget.ip.trim()}.` +
              (removeIsLighthouse
                ? ' It is listed as a lighthouse — without this entry the node cannot reach it for discovery.'
                : '') +
              ' The change applies when you save the network configuration.'
            : ''
        }
        confirmText="Remove entry"
        destructive
      />

      <ModalForm
        isOpen={!!issued}
        onClose={closeIssuedModal}
        title={issued && issued.Installed ? 'Certificate installed' : 'Certificate issued'}
      >
        {issued ? (
          <VStack space="md">
            {issued.Installed ? (
              <Text size="sm" color="$muted500">
                This certificate is now the router's identity — the private key
                is stored on the router and nebula restarts with it.
              </Text>
            ) : null}
            {keyPending ? (
              <Text size="sm" color="$muted500">
                Copy or download the private key now — it is not stored on the
                router and cannot be shown again.
              </Text>
            ) : null}
            <PemBlock
              label="Certificate"
              value={issued.Cert || ''}
              filename={`${issued.RequestedName || 'node'}.crt`}
              onCopied={() => alert.success('Copied certificate')}
            />
            {keyPending ? (
              <>
                <PemBlock
                  label="Private key (shown once)"
                  value={issued.Key}
                  filename={`${issued.RequestedName || 'node'}.key`}
                  onCopied={() => alert.success('Copied private key')}
                />
                <ToggleRow
                  label="I've saved the private key"
                  description="Required before closing — the key cannot be recovered"
                  value={ackKeySaved}
                  onPress={() => setAckKeySaved(!ackKeySaved)}
                />
              </>
            ) : null}
            <HStack justifyContent="flex-end">
              <Button
                size="sm"
                variant="outline"
                onPress={closeIssuedModal}
                isDisabled={keyPending && !ackKeySaved}
              >
                <ButtonText>Done</ButtonText>
              </Button>
            </HStack>
          </VStack>
        ) : (
          <VStack />
        )}
      </ModalForm>
    </Page>
  )
}
