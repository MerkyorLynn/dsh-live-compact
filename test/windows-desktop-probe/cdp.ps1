param([Parameter(Mandatory)][uri]$Endpoint, [Parameter(Mandatory)][int]$Port, [ValidateSet('Plugins','Add plugin','Choose how to add a plugin','Install','CandidateDetails')][string]$Click, [uri]$PackageAddress)
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
  buttons: [...document.querySelectorAll('button, [role="button"], [role="menuitem"], a')]
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
  const entry = [...document.querySelectorAll('button, [role="button"]')].find(el => {
    const label = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim();
    return el.getClientRects().length && (__LABEL__ === 'CandidateDetails'
      ? /^View\s+.*(?:Live Compact|dsh-live-compact|边做边压)/i.test(label) : label === __LABEL__);
  });
  if (!entry || entry.disabled || entry.getAttribute('aria-disabled') === 'true') return false;
  entry.click();
  return true;
})()
'@
        $expression = $expression.Replace('__LABEL__', (ConvertTo-Json -InputObject $Click -Compress))
    }
    if ($PackageAddress) {
        if ($PackageAddress.Scheme -ne 'https' -or $PackageAddress.Host -ne 'raw.githubusercontent.com' -or
            $PackageAddress.AbsolutePath -ne '/Tranquillitatis-Lab/dsh-live-compact/93c73ec334d302ff0e2d7ffb2ffc8ee26bc402f0/test/windows-runtime/fixtures/dsh-live-compact-1.1.2.tgz') {
            throw 'Package address is outside the frozen fixture.'
        }
        $expression = @'
(() => {
  if (location.protocol !== 'dsh-app:') return false;
  const input = document.querySelector('input[aria-label="Package name or address"]');
  if (!input || !input.getClientRects().length) return false;
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, __ADDRESS__);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value === __ADDRESS__;
})()
'@
        $expression = $expression.Replace('__ADDRESS__', (ConvertTo-Json -InputObject $PackageAddress.AbsoluteUri -Compress))
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
    if ($null -eq $response.result.result.value) { throw 'CDP returned no page evidence.' }
    $response.result.result.value
} finally {
    $deadline.Dispose()
    $socket.Dispose()
}
