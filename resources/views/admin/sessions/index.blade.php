@extends('admin.layouts.app')
@section('title', 'AI Sessions')
@section('content')
<div class="card">
    <div class="card-body table-responsive p-0">
        <table class="table table-striped mb-0">
            <thead>
            <tr>
                <th>ID</th><th>Title</th><th>User</th><th>Mode</th><th>Source</th><th>Status</th><th>Duration</th><th></th>
            </tr>
            </thead>
            <tbody>
            @forelse($sessions as $session)
                <tr>
                    <td>{{ $session->id }}</td>
                    <td>{{ $session->title }}</td>
                    <td>{{ $session->user?->email }}</td>
                    <td>{{ $session->mode }}</td>
                    <td>{{ $session->source }}</td>
                    <td>{{ $session->status }}</td>
                    <td>{{ gmdate('H:i:s', $session->duration_seconds) }}</td>
                    <td><a href="{{ route('admin.sessions.show', $session) }}">View</a></td>
                </tr>
            @empty
                <tr><td colspan="8" class="text-center text-muted py-4">No sessions</td></tr>
            @endforelse
            </tbody>
        </table>
    </div>
</div>
<div class="mt-3">{{ $sessions->links() }}</div>
@endsection
