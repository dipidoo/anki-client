<?php
// anki-client OAuth proxy (OCF shared-hosting PHP).
//
// Purpose: implement step 5 of OAuth2 web flow — exchange the auth code for an
// access token. The client_secret stays on the server; the browser never sees it.
// All other GitHub API calls are made directly from the SPA against api.github.com
// (which sends proper CORS headers for authenticated requests).
//
// Deploy: see ./README.md.

declare(strict_types=1);

const ALLOWED_ORIGINS = [
    'https://dipidoo.github.io',
    'http://localhost:5173', // vite dev server
];

const GITHUB_CLIENT_ID = 'Ov23liNeYzb2SRSZLynD';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// Secret lives OUTSIDE public_html. See README for setup.
const SECRET_PATH = __DIR__ . '/../../.config/anki-oauth/client_secret';

// ---- CORS ---------------------------------------------------------------

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowOrigin = in_array($origin, ALLOWED_ORIGINS, true) ? $origin : ALLOWED_ORIGINS[0];
header("Access-Control-Allow-Origin: $allowOrigin");
header('Vary: Origin');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Max-Age: 86400');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

header('Content-Type: application/json; charset=utf-8');

// ---- Dispatch -----------------------------------------------------------

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'method_not_allowed']);
    exit;
}

// Parse body (accept JSON or form-urlencoded for flexibility).
$raw = file_get_contents('php://input');
$contentType = $_SERVER['CONTENT_TYPE'] ?? '';
$body = [];
if (str_contains($contentType, 'application/json')) {
    $body = json_decode($raw, true) ?: [];
} else {
    parse_str($raw, $body);
}

$code = $body['code'] ?? '';
if (!is_string($code) || $code === '') {
    http_response_code(400);
    echo json_encode(['error' => 'missing_code']);
    exit;
}

// ---- Load secret --------------------------------------------------------

if (!is_readable(SECRET_PATH)) {
    http_response_code(500);
    error_log('anki-oauth: secret file not readable at ' . SECRET_PATH);
    echo json_encode(['error' => 'server_misconfigured']);
    exit;
}
$clientSecret = trim((string) file_get_contents(SECRET_PATH));
if ($clientSecret === '') {
    http_response_code(500);
    error_log('anki-oauth: secret file empty');
    echo json_encode(['error' => 'server_misconfigured']);
    exit;
}

// ---- Forward to GitHub --------------------------------------------------

$post = http_build_query([
    'client_id'     => GITHUB_CLIENT_ID,
    'client_secret' => $clientSecret,
    'code'          => $code,
]);

$ch = curl_init(GITHUB_TOKEN_URL);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $post,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER     => [
        'Accept: application/json',
        'User-Agent: anki-client-oauth-proxy',
    ],
    CURLOPT_TIMEOUT        => 10,
    CURLOPT_CONNECTTIMEOUT => 5,
]);
$resp   = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err    = curl_error($ch);
curl_close($ch);

if ($resp === false) {
    http_response_code(502);
    error_log('anki-oauth: curl error: ' . $err);
    echo json_encode(['error' => 'upstream_unreachable', 'detail' => $err]);
    exit;
}

http_response_code($status ?: 502);
echo $resp; // GitHub already returns JSON; pass through verbatim.
