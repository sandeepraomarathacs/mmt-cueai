@extends('admin.layouts.app')
@section('title', $user->exists ? 'Edit User' : 'Add User')
@section('content')
<div class="card" style="max-width:640px">
    <div class="card-body">
        <form method="POST" action="{{ $user->exists ? route('admin.users.update', $user) : route('admin.users.store') }}">
            @csrf
            @if($user->exists) @method('PUT') @endif
            <div class="mb-3">
                <label class="form-label">Name</label>
                <input type="text" name="name" value="{{ old('name', $user->name) }}" class="form-control" required>
            </div>
            <div class="mb-3">
                <label class="form-label">Email</label>
                <input type="email" name="email" value="{{ old('email', $user->email) }}" class="form-control" required>
            </div>
            <div class="mb-3">
                <label class="form-label">Password {{ $user->exists ? '(leave blank to keep)' : '' }}</label>
                <input type="password" name="password" class="form-control" {{ $user->exists ? '' : 'required' }}>
            </div>
            <div class="form-check mb-3">
                <input class="form-check-input" type="checkbox" name="is_active" value="1" id="is_active"
                       @checked(old('is_active', $user->is_active ?? true))>
                <label class="form-check-label" for="is_active">Active</label>
            </div>
            <button class="btn btn-success">Save</button>
            <a href="{{ route('admin.users.index') }}" class="btn btn-light">Cancel</a>
        </form>
    </div>
</div>
@endsection
