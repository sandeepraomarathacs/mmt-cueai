<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\AiMessage;
use App\Models\AiSession;
use App\Models\AppSetting;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

class SessionController extends Controller
{
    public function index(Request $request)
    {
        $sessions = AiSession::query()
            ->where('user_id', $request->user()->id)
            ->latest()
            ->paginate(20);

        return response()->json($sessions);
    }

    public function store(Request $request)
    {
        $data = $request->validate([
            'title' => ['required', 'string', 'max:255'],
            'mode' => ['nullable', 'in:interview,sales,meeting,regular'],
            'language' => ['nullable', 'string', 'max:50'],
            'source' => ['nullable', 'in:web,desktop,app'],
            'context' => ['nullable', 'string'],
        ]);

        $session = AiSession::create([
            'user_id' => $request->user()->id,
            'title' => $data['title'],
            'mode' => $data['mode'] ?? 'interview',
            'language' => $data['language'] ?? 'English',
            'source' => $data['source'] ?? 'web',
            'context' => $data['context'] ?? null,
            'status' => 'ready',
        ]);

        return response()->json($session, 201);
    }

    public function show(Request $request, AiSession $session)
    {
        $this->authorizeSession($request, $session);
        $session->load(['messages' => fn ($q) => $q->latest()]);

        return response()->json($session);
    }

    public function start(Request $request, AiSession $session)
    {
        $this->authorizeSession($request, $session);
        $session->update([
            'status' => 'live',
            'started_at' => $session->started_at ?? now(),
        ]);

        return response()->json($session->fresh());
    }

    public function end(Request $request, AiSession $session)
    {
        $this->authorizeSession($request, $session);

        $started = $session->started_at;
        $duration = $started ? now()->diffInSeconds($started) : $session->duration_seconds;

        $session->update([
            'status' => 'ended',
            'ended_at' => now(),
            'duration_seconds' => $duration,
            'summary' => $request->input('summary', $session->summary),
            'transcript' => $request->input('transcript', $session->transcript),
        ]);

        return response()->json($session->fresh());
    }

    public function askText(Request $request, AiSession $session)
    {
        $this->authorizeSession($request, $session);

        $data = $request->validate([
            'text' => ['required', 'string'],
        ]);

        [$pythonUrl, $apiKey] = $this->pythonConnection();

        $response = Http::timeout(120)
            ->withHeaders(['X-API-Key' => $apiKey])
            ->post("{$pythonUrl}/ask/text", [
                'text' => $data['text'],
                'session_id' => $session->id,
                'mode' => $session->mode,
                'context' => $session->context,
                'language' => $session->language,
            ]);

        if (!$response->successful()) {
            return response()->json([
                'message' => 'AI processing failed',
                'detail' => $response->json() ?? $response->body(),
            ], 502);
        }

        $payload = $response->json();

        $message = AiMessage::create([
            'ai_session_id' => $session->id,
            'channel' => 'text',
            'input' => $data['text'],
            'answer' => $payload['answer'] ?? null,
            'model' => $payload['model'] ?? null,
            'meta' => $payload,
        ]);

        if ($session->status === 'ready') {
            $session->update(['status' => 'live', 'started_at' => $session->started_at ?? now()]);
        }

        return response()->json([
            'message' => $message,
            'answer' => $payload['answer'] ?? null,
            'raw' => $payload,
        ]);
    }

    public function askAudio(Request $request, AiSession $session)
    {
        $this->authorizeSession($request, $session);

        $request->validate([
            'file' => ['required', 'file'],
        ]);

        [$pythonUrl, $apiKey] = $this->pythonConnection();

        $response = Http::timeout(180)
            ->withHeaders(['X-API-Key' => $apiKey])
            ->attach('file', file_get_contents($request->file('file')->getRealPath()), $request->file('file')->getClientOriginalName())
            ->post("{$pythonUrl}/ask/audio", [
                'mode' => $session->mode,
                'language' => $session->language,
                'context' => $session->context,
                'session_id' => (string) $session->id,
            ]);

        if (!$response->successful()) {
            return response()->json([
                'message' => 'AI audio processing failed',
                'detail' => $response->json() ?? $response->body(),
            ], 502);
        }

        $payload = $response->json();
        $message = AiMessage::create([
            'ai_session_id' => $session->id,
            'channel' => 'voice',
            'input' => '[audio upload]',
            'answer' => $payload['answer'] ?? null,
            'model' => $payload['model'] ?? null,
            'meta' => $payload,
        ]);

        return response()->json([
            'message' => $message,
            'answer' => $payload['answer'] ?? null,
            'raw' => $payload,
        ]);
    }

    public function askScreen(Request $request, AiSession $session)
    {
        $this->authorizeSession($request, $session);

        $request->validate([
            'file' => ['required', 'file', 'image'],
            'prompt' => ['nullable', 'string'],
        ]);

        [$pythonUrl, $apiKey] = $this->pythonConnection();

        $response = Http::timeout(180)
            ->withHeaders(['X-API-Key' => $apiKey])
            ->attach('file', file_get_contents($request->file('file')->getRealPath()), $request->file('file')->getClientOriginalName())
            ->post("{$pythonUrl}/ask/screen", [
                'prompt' => $request->input('prompt', 'What is on the screen? If there is a question or coding problem, solve it.'),
                'mode' => $session->mode,
                'language' => $session->language,
                'context' => $session->context,
                'session_id' => (string) $session->id,
            ]);

        if (!$response->successful()) {
            return response()->json([
                'message' => 'AI screen processing failed',
                'detail' => $response->json() ?? $response->body(),
            ], 502);
        }

        $payload = $response->json();
        $message = AiMessage::create([
            'ai_session_id' => $session->id,
            'channel' => 'screen',
            'input' => $request->input('prompt'),
            'answer' => $payload['answer'] ?? null,
            'model' => $payload['model'] ?? null,
            'meta' => $payload,
        ]);

        return response()->json([
            'message' => $message,
            'answer' => $payload['answer'] ?? null,
            'raw' => $payload,
        ]);
    }

    public function storeMessage(Request $request, AiSession $session)
    {
        $this->authorizeSession($request, $session);

        $data = $request->validate([
            'channel' => ['required', 'in:text,voice,screen'],
            'input' => ['nullable', 'string'],
            'answer' => ['nullable', 'string'],
            'model' => ['nullable', 'string'],
            'meta' => ['nullable', 'array'],
        ]);

        $message = AiMessage::create([
            'ai_session_id' => $session->id,
            ...$data,
        ]);

        return response()->json($message, 201);
    }

    public function config()
    {
        // Public/minimal — never expose API key here
        return response()->json([
            'python_ws_url' => AppSetting::getValue('python_ws_url', env('PYTHON_WS_URL')),
            'python_api_url' => AppSetting::getValue('python_api_url', env('PYTHON_API_URL')),
        ]);
    }

    /**
     * Authenticated realtime config for desktop/app WebSocket streaming.
     * Key is only returned to logged-in users (not public /config).
     */
    public function realtimeConfig()
    {
        $wsUrl = (string) AppSetting::getValue('python_ws_url', env('PYTHON_WS_URL'));
        $apiKey = (string) AppSetting::getValue('python_api_key', env('PYTHON_API_KEY'));

        if ($wsUrl === '' || $apiKey === '') {
            return response()->json(['message' => 'Realtime AI is not configured'], 503);
        }

        $separator = str_contains($wsUrl, '?') ? '&' : '?';
        $connectedUrl = $wsUrl.$separator.'api_key='.urlencode($apiKey);

        return response()->json([
            'ws_url' => $connectedUrl,
            'chunk_process_seconds' => 12,
            'sample_rate' => 16000,
        ]);
    }

    private function authorizeSession(Request $request, AiSession $session): void
    {
        if ($session->user_id !== $request->user()->id) {
            abort(403);
        }
    }

    /**
     * @return array{0: string, 1: string}
     */
    private function pythonConnection(): array
    {
        $pythonUrl = rtrim((string) AppSetting::getValue('python_api_url', env('PYTHON_API_URL')), '/');
        $apiKey = (string) AppSetting::getValue('python_api_key', env('PYTHON_API_KEY'));

        if ($pythonUrl === '' || $apiKey === '') {
            abort(503, 'Python API URL / PYTHON_API_KEY is not configured');
        }

        return [$pythonUrl, $apiKey];
    }
}

