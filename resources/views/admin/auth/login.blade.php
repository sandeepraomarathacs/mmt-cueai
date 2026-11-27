<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Admin Login | Parakeet</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
    <style>
        body {
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: radial-gradient(circle at top left, #134e4a, #0f172a 55%);
            color: #fff;
        }
        .card {
            width: min(420px, 92vw);
            border: 0;
            border-radius: 1rem;
            box-shadow: 0 20px 50px rgba(0,0,0,.35);
        }
        .brand { font-weight: 700; color: #0f766e; }
    </style>
</head>
<body>
<div class="card p-4">
    <h1 class="h4 brand mb-1">Parakeet Admin</h1>
    <p class="text-muted mb-4">Super admin sign in</p>
    @if($errors->any())
        <div class="alert alert-danger py-2">{{ $errors->first() }}</div>
    @endif
    <form method="POST" action="{{ route('admin.login.submit') }}">
        @csrf
        <div class="mb-3">
            <label class="form-label">Email</label>
            <input type="email" name="email" value="{{ old('email', 'admin@gmail.com') }}" class="form-control" required>
        </div>
        <div class="mb-3">
            <label class="form-label">Password</label>
            <input type="password" name="password" class="form-control" required>
        </div>
        <div class="form-check mb-3">
            <input class="form-check-input" type="checkbox" name="remember" id="remember">
            <label class="form-check-label" for="remember">Remember me</label>
        </div>
        <button class="btn btn-success w-100">Login</button>
    </form>
</div>
</body>
</html>
