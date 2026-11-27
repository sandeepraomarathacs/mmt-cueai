<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Models\AiSession;

class SessionAdminController extends Controller
{
    public function index()
    {
        $sessions = AiSession::query()->with('user')->latest()->paginate(20);

        return view('admin.sessions.index', compact('sessions'));
    }

    public function show(AiSession $session)
    {
        $session->load(['user', 'messages' => fn ($q) => $q->latest()]);

        return view('admin.sessions.show', compact('session'));
    }
}
