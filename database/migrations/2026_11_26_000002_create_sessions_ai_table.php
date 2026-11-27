<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_sessions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('title');
            $table->string('mode')->default('interview'); // interview | sales | meeting | regular
            $table->string('language')->default('English');
            $table->string('source')->default('web'); // web | desktop | app
            $table->string('status')->default('ready'); // ready | live | ended
            $table->text('context')->nullable();
            $table->longText('transcript')->nullable();
            $table->longText('summary')->nullable();
            $table->unsignedInteger('duration_seconds')->default(0);
            $table->timestamp('started_at')->nullable();
            $table->timestamp('ended_at')->nullable();
            $table->timestamps();
        });

        Schema::create('ai_messages', function (Blueprint $table) {
            $table->id();
            $table->foreignId('ai_session_id')->constrained('ai_sessions')->cascadeOnDelete();
            $table->string('channel'); // text | voice | screen
            $table->longText('input')->nullable();
            $table->longText('answer')->nullable();
            $table->string('model')->nullable();
            $table->json('meta')->nullable();
            $table->timestamps();
        });

        Schema::create('app_settings', function (Blueprint $table) {
            $table->id();
            $table->string('key')->unique();
            $table->text('value')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_messages');
        Schema::dropIfExists('ai_sessions');
        Schema::dropIfExists('app_settings');
    }
};
