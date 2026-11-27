<?php

namespace App\Providers;

use App\Models\AiSession;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        Route::bind('session', function (string $value) {
            return AiSession::query()->findOrFail($value);
        });
    }
}

