@extends('admin.layouts.app')
@section('title', 'Session #'.$session->id)
@section('content')
<div class="card mb-3">
    <div class="card-body">
        <p><strong>Title:</strong> {{ $session->title }}</p>
        <p><strong>User:</strong> {{ $session->user?->email }}</p>
        <p><strong>Mode / Source / Status:</strong> {{ $session->mode }} / {{ $session->source }} / {{ $session->status }}</p>
        <p><strong>Language:</strong> {{ $session->language }}</p>
        @if($session->context)
            <p><strong>Context:</strong></p>
            <pre class="bg-light p-3 rounded">{{ $session->context }}</pre>
        @endif
        @if($session->summary)
            <p><strong>Summary:</strong></p>
            <pre class="bg-light p-3 rounded">{{ $session->summary }}</pre>
        @endif
    </div>
</div>

<div class="card">
    <div class="card-header"><strong>Messages</strong></div>
    <div class="card-body">
        @forelse($session->messages as $message)
            <div class="border rounded p-3 mb-3">
                <div class="d-flex justify-content-between">
                    <span class="badge text-bg-info">{{ $message->channel }}</span>
                    <small class="text-muted">{{ $message->created_at }}</small>
                </div>
                @if($message->input)
                    <p class="mt-2 mb-1"><strong>Input</strong></p>
                    <pre class="mb-2">{{ $message->input }}</pre>
                @endif
                <p class="mb-1"><strong>Answer</strong></p>
                <pre class="mb-0">{{ $message->answer }}</pre>
            </div>
        @empty
            <p class="text-muted mb-0">No messages</p>
        @endforelse
    </div>
</div>
@endsection
