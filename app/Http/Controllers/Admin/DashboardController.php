<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Models\AiMessage;
use App\Models\AiSession;
use App\Models\User;

class DashboardController extends Controller
{
    public function index()
    {
        return view('admin.dashboard', [
            'usersCount' => User::query()->where('role', 'user')->count(),
            'sessionsCount' => AiSession::query()->count(),
            'liveCount' => AiSession::query()->where('status', 'live')->count(),
            'messagesCount' => AiMessage::query()->count(),
            'recentSessions' => AiSession::query()->with('user')->latest()->limit(10)->get(),
        ]);
    }
}
