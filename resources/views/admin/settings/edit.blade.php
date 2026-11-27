@extends('admin.layouts.app')
@section('title', 'Settings')
@section('content')
<div class="card" style="max-width:720px">
    <div class="card-body">
        <form method="POST" action="{{ route('admin.settings.update') }}">
            @csrf
            <div class="mb-3">
                <label class="form-label">Python API URL</label>
                <input type="url" name="python_api_url" value="{{ old('python_api_url', $python_api_url) }}" class="form-control" required>
            </div>
            <div class="mb-3">
                <label class="form-label">Python WebSocket URL</label>
                <input type="text" name="python_ws_url" value="{{ old('python_ws_url', $python_ws_url) }}" class="form-control" required>
            </div>
            <div class="mb-3">
                <label class="form-label">Python API Key</label>
                <input type="text" name="python_api_key" value="{{ old('python_api_key', $python_api_key) }}" class="form-control" required>
            </div>
            <div class="mb-3">
                <label class="form-label">Gemini Model (reference)</label>
                <input type="text" name="gemini_model" value="{{ old('gemini_model', $gemini_model) }}" class="form-control" required>
                <div class="form-text">Actual model key is set in python/.env (GEMINI_API_KEY / GEMINI_MODEL).</div>
            </div>
            <button class="btn btn-success">Save Settings</button>
        </form>
    </div>
</div>
@endsection
