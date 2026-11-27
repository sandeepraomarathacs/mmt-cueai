<?php

namespace Database\Seeders;

use App\Models\AppSetting;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        User::query()->updateOrCreate(
            ['email' => 'admin@gmail.com'],
            [
                'name' => 'Super Admin',
                'password' => Hash::make('test@1234'),
                'role' => 'admin',
                'is_active' => true,
                'email_verified_at' => now(),
            ]
        );

        User::query()->updateOrCreate(
            ['email' => 'sandeep@gmail.com'],
            [
                'name' => 'Sandeep',
                'password' => Hash::make('test@1234'),
                'role' => 'user',
                'is_active' => true,
                'email_verified_at' => now(),
            ]
        );

        // Secrets/URLs come from .env — never hardcode defaults in code
        AppSetting::setValue('python_api_url', env('PYTHON_API_URL', 'https://ai.cueai.manmayitech.com'));
        AppSetting::setValue('python_ws_url', env('PYTHON_WS_URL', 'wss://ai.cueai.manmayitech.com/ws/audio'));
        AppSetting::setValue('python_api_key', env('PYTHON_API_KEY'));
        AppSetting::setValue('gemini_model', env('GEMINI_MODEL', 'gemini-2.0-flash'));

    }
}
