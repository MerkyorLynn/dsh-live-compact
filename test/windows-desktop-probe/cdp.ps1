param([Parameter(Mandatory)][uri]$Endpoint, [Parameter(Mandatory)][int]$Port, [ValidateSet('Plugins','Add plugin','Choose how to add a plugin','Install','Refresh','DismissInstall','CandidateDetails','EnableCandidate','SaveCandidate')][string]$Click, [uri]$PackageAddress, [ValidateSet('24000','25000')][string]$SettingValue)
$ErrorActionPreference = 'Stop'
if ($Endpoint.Scheme -ne 'ws' -or $Endpoint.Host -ne '127.0.0.1' -or $Endpoint.Port -ne $Port) {
    throw 'CDP must stay on the test application loopback port.'
}
$socket = [Net.WebSockets.ClientWebSocket]::new()
$deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(15))
try {
    $socket.ConnectAsync($Endpoint, $deadline.Token).GetAwaiter().GetResult() | Out-Null
    $expression = @'
JSON.stringify({
  title: document.title.slice(0, 80),
  protocol: location.protocol,
  path: location.pathname.slice(0, 100),
  ready: document.readyState,
  documentNodes: document.body?.childElementCount || 0,
  status: (document.body?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 180),
  pluginStatus: (document.body?.innerText || '').split('\n')
    .filter(text => /live compact|dsh-live-compact|compaction-spine|边做边压|install|restart|起切/i.test(text))
    .slice(0, 25).map(text => text.trim().slice(0, 180)),
  minTokens: (() => {
    const root = document.getElementById('live-compact-minTokens');
    const field = root?.matches('input') ? root : root?.querySelector('input');
    if (!field) return null;
    field.scrollIntoView({block: 'center'});
    const rect = field.getBoundingClientRect(), style = getComputedStyle(field);
    const visible = !!field.getClientRects().length && rect.width > 0 && rect.height > 0 &&
      style.visibility === 'visible' && style.opacity !== '0' &&
      !field.closest('[hidden], [inert], [aria-hidden="true"]');
    const hit = visible ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
    return {value: field.value, visible: visible && (hit === field || field.contains(hit)),
      disabled: field.matches(':disabled') || field.getAttribute('aria-disabled') === 'true', readOnly: field.readOnly};
  })(),
  buttons: [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="switch"], a')]
    .filter(el => el.getClientRects().length)
    .map(el => (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().slice(0, 70))
    .filter(Boolean).slice(0, 50),
  inputs: [...document.querySelectorAll('input')].filter(el => el.getClientRects().length)
    .map(el => ({type: el.type, label: el.getAttribute('aria-label') || el.labels?.[0]?.innerText || null,
      placeholder: el.placeholder, min: el.min || null, max: el.max || null})).slice(0, 24)
})
'@
    if ($Click) {
        $expression = @'
(() => {
  if (location.protocol !== 'dsh-app:') return false;
  const installDialogs = [...document.querySelectorAll('[role="dialog"]')].filter(el => el.getClientRects().length &&
    (el.querySelector('input[aria-label="Package name or address"]') || /dsh-live-compact/.test(el.innerText || '')));
  const installDialog = installDialogs.length === 1 ? installDialogs[0] : null;
  const field = document.getElementById('live-compact-minTokens');
  const scope = __LABEL__ === 'DismissInstall' ? installDialog : __LABEL__ === 'SaveCandidate'
    ? field?.closest('form, [role="form"], [data-plugin-row-detail="dsh-live-compact#compaction-spine"]') : document;
  if (!scope) return false;
  const entry = [...scope.querySelectorAll('button, [role="button"], [role="switch"]')].find(el => {
    const label = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim();
    if (!el.getClientRects().length) return false;
    switch (__LABEL__) {
      case 'CandidateDetails': return /^(?:(?:View|Manage|Configure)\s+|查看\s*|配置\s*)(?:Live Compact|dsh-live-compact|compaction-spine|边做边压)$/i.test(label) ||
        (el.closest('[data-plugin-row="compaction-spine"]') && /^(?:Configure\s+|配置\s*)/.test(label));
      case 'EnableCandidate': return (label === 'Enable now' || /^(?:Enable\s+|启用\s*)(?:dsh-live-compact|Live Compact|compaction-spine|边做边压)$/i.test(label)) &&
        el.getAttribute('aria-checked') !== 'true' && !el.checked;
      case 'SaveCandidate': return label === 'Save' || label === '保存';
      case 'DismissInstall': return label === 'Close';
      default: return label === __LABEL__;
    }
  });
  if (!entry || entry.matches(':disabled') || entry.getAttribute('aria-disabled') === 'true' ||
      entry.closest('[inert], [aria-hidden="true"]') || getComputedStyle(entry).visibility !== 'visible') return false;
  entry.scrollIntoView({block: 'center'});
  const rect = entry.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (rect.width <= 0 || rect.height <= 0 || !(hit === entry || entry.contains(hit))) return false;
  entry.click();
  return true;
})()
'@
        $expression = $expression.Replace('__LABEL__', (ConvertTo-Json -InputObject $Click -Compress))
    }
    if ($PackageAddress) {
        if ($PackageAddress.Scheme -ne 'https' -or $PackageAddress.Host -ne 'raw.githubusercontent.com' -or
            $PackageAddress.AbsolutePath -ne '/Tranquillitatis-Lab/dsh-live-compact/d91c2790de3aabea133e111dde98eaf2c10cc0e9/test/windows-runtime/fixtures/dsh-live-compact-1.1.2.tgz') {
            throw 'Package address is outside the frozen fixture.'
        }
        $expression = @'
(() => {
  if (location.protocol !== 'dsh-app:') return false;
  const input = document.querySelector('input[aria-label="Package name or address"]');
  if (!input || input.matches(':disabled') || input.readOnly || !input.getClientRects().length) return false;
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, __ADDRESS__);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value === __ADDRESS__;
})()
'@
        $expression = $expression.Replace('__ADDRESS__', (ConvertTo-Json -InputObject $PackageAddress.AbsoluteUri -Compress))
    }
    if ($SettingValue) {
        $expression = @'
(() => {
  if (location.protocol !== 'dsh-app:') return false;
  const root = document.getElementById('live-compact-minTokens');
  const input = root?.matches('input') ? root : root?.querySelector('input');
  if (!input || input.matches(':disabled') || input.readOnly || input.getAttribute('aria-disabled') === 'true' ||
      input.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  input.scrollIntoView({block: 'center'});
  const rect = input.getBoundingClientRect();
  if (!input.getClientRects().length || rect.width <= 0 || rect.height <= 0 ||
      getComputedStyle(input).visibility !== 'visible' ||
      document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) !== input) return false;
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, __VALUE__);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur();
  return input.value === __VALUE__;
})()
'@
        $expression = $expression.Replace('__VALUE__', (ConvertTo-Json -InputObject $SettingValue -Compress))
    }
    $command = @{ id=1; method='Runtime.evaluate'; params=@{ expression=$expression; returnByValue=$true } } | ConvertTo-Json -Compress -Depth 5
    $packet = [ArraySegment[byte]]::new([Text.Encoding]::UTF8.GetBytes($command))
    $socket.SendAsync($packet, [Net.WebSockets.WebSocketMessageType]::Text, $true, $deadline.Token).GetAwaiter().GetResult() | Out-Null
    $buffer = [byte[]]::new(8192)
    do {
        $message = [IO.MemoryStream]::new()
        try {
            do {
                $piece = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $deadline.Token).GetAwaiter().GetResult()
                if ($piece.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close -or $message.Length + $piece.Count -gt 1048576) {
                    throw 'Unexpected CDP message size or close.'
                }
                $message.Write($buffer, 0, $piece.Count)
            } until ($piece.EndOfMessage)
            $response = [Text.Encoding]::UTF8.GetString($message.ToArray()) | ConvertFrom-Json
        } finally { $message.Dispose() }
    } until ($response.id -eq 1)
    if ($response.error -or $response.result.exceptionDetails) { throw 'CDP evaluation failed.' }
    if ($null -eq $response.result.result.value) { throw 'CDP returned no page evidence.' }
    $response.result.result.value
} finally {
    $deadline.Dispose()
    $socket.Dispose()
}
