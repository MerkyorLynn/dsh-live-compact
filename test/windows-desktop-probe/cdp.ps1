param([Parameter(Mandatory)][uri]$Endpoint, [Parameter(Mandatory)][int]$Port, [switch]$OpenPluginManager)
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
  buttons: [...document.querySelectorAll('button, [role="button"], a')]
    .filter(el => el.getClientRects().length)
    .map(el => (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().slice(0, 70))
    .filter(Boolean).slice(0, 35)
})
'@
    if ($OpenPluginManager) {
        $expression = @'
(() => {
  if (location.protocol !== 'dsh-app:') return false;
  const entry = [...document.querySelectorAll('button, [role="button"]')].find(el =>
    el.getClientRects().length && (el.getAttribute('aria-label') || el.title || el.textContent || '').trim() === 'Plugins');
  if (!entry) return false;
  entry.click();
  return true;
})()
'@
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
