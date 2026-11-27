@extends('admin.layouts.app')
@section('title', 'Dashboard')
@section('content')
<div class="row">
    <div class="col-lg-3 col-6">
        <div class="small-box text-bg-primary p-3 mb-3">
            <div class="inner"><h3>{{ $usersCount }}</h3><p>Users</p></div>
        </div>
    </div>
    <div class="col-lg-3 col-6">
        <div class="small-box text-bg-success p-3 mb-3">
            <div class="inner"><h3>{{ $sessionsCount }}</h3><p>Sessions</p></div>
        </div>
    </div>
    <div class="col-lg-3 col-6">
        <div class="small-box text-bg-warning p-3 mb-3">
            <div class="inner"><h3>{{ $liveCount }}</h3><p>Live</p></div>
        </div>
    </div>
    <div class="col-lg-3 col-6">
        <div class="small-box text-bg-danger p-3 mb-3">
            <div class="inner"><h3>{{ $messagesCount }}</h3><p>AI Messages</p></div>
        </div>
    </div>
</div>

<div class="card">
    <div class="card-header"><strong>Recent Sessions</strong></div>
    <div class="card-body table-responsive p-0">
        <table class="table table-striped mb-0">
            <thead>
            <tr>
                <th>ID</th><th>Title</th><th>User</th><th>Mode</th><th>Source</th><th>Status</th><th></th>
            </tr>
            </thead>
            <tbody>
            @forelse($recentSessions as $session)
                <tr>
                    <td>{{ $session->id }}</td>
                    <td>{{ $session->title }}</td>
                    <td>{{ $session->user?->email }}</td>
                    <td>{{ $session->mode }}</td>
                    <td>{{ $session->source }}</td>
                    <td><span class="badge text-bg-secondary">{{ $session->status }}</span></td>
                    <td><a href="{{ route('admin.sessions.show', $session) }}">View</a></td>
                </tr>
            @empty
                <tr><td colspan="7" class="text-center text-muted py-4">No sessions yet</td></tr>
            @endforelse
            </tbody>
        </table>
    </div>
</div>
@endsection
