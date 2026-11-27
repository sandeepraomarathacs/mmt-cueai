<?php

use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\SessionController;
use Illuminate\Support\Facades\Route;

Route::post('/login', [AuthController::class, 'login']);
Route::get('/config', [SessionController::class, 'config']);

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/me', [AuthController::class, 'me']);
    Route::post('/logout', [AuthController::class, 'logout']);
    Route::get('/realtime-config', [SessionController::class, 'realtimeConfig']);

    Route::get('/sessions', [SessionController::class, 'index']);
    Route::post('/sessions', [SessionController::class, 'store']);
    Route::get('/sessions/{session}', [SessionController::class, 'show']);
    Route::post('/sessions/{session}/start', [SessionController::class, 'start']);
    Route::post('/sessions/{session}/end', [SessionController::class, 'end']);
    Route::post('/sessions/{session}/ask/text', [SessionController::class, 'askText']);
    Route::post('/sessions/{session}/ask/audio', [SessionController::class, 'askAudio']);
    Route::post('/sessions/{session}/ask/screen', [SessionController::class, 'askScreen']);
    Route::post('/sessions/{session}/messages', [SessionController::class, 'storeMessage']);
});
