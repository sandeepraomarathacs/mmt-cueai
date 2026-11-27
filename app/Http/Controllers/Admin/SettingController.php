<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Models\AppSetting;
use Illuminate\Http\Request;

class SettingController extends Controller
{
    public function edit()
    {
        return view('admin.settings.edit', [
            'python_api_url' => AppSetting::getValue('python_api_url', env('PYTHON_API_URL')),
            'python_ws_url' => AppSetting::getValue('python_ws_url', env('PYTHON_WS_URL')),
            'python_api_key' => AppSetting::getValue('python_api_key', env('PYTHON_API_KEY')),
            'gemini_model' => AppSetting::getValue('gemini_model', env('GEMINI_MODEL', 'gemini-2.0-flash')),
        ]);

    }

    public function update(Request $request)
    {
        $data = $request->validate([
            'python_api_url' => ['required', 'url'],
            'python_ws_url' => ['required', 'string'],
            'python_api_key' => ['required', 'string'],
            'gemini_model' => ['required', 'string'],
        ]);

        foreach ($data as $key => $value) {
            AppSetting::setValue($key, $value);
        }

        return back()->with('success', 'Settings saved');
    }
}
