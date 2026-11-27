import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../config.dart';

class ApiService {
  String? _token;

  Future<void> loadToken() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString('token');
  }

  Future<void> saveToken(String token) async {
    _token = token;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('token', token);
  }

  Future<void> clearToken() async {
    _token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('token');
    await prefs.remove('user');
  }

  Map<String, String> _headers({bool json = true}) {
    final h = <String, String>{
      'Accept': 'application/json',
      if (json) 'Content-Type': 'application/json',
      if (_token != null) 'Authorization': 'Bearer $_token',
    };
    return h;
  }

  Future<Map<String, dynamic>> login(String email, String password) async {
    final res = await http.post(
      Uri.parse('${AppConfig.apiBaseUrl}/login'),
      headers: _headers(),
      body: jsonEncode({
        'email': email,
        'password': password,
        'device_name': 'app',
      }),
    );
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) {
      throw Exception(data['message'] ?? data['email']?[0] ?? 'Login failed');
    }
    await saveToken(data['token'] as String);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('user', jsonEncode(data['user']));
    return data;
  }

  Future<List<dynamic>> sessions() async {
    final res = await http.get(
      Uri.parse('${AppConfig.apiBaseUrl}/sessions'),
      headers: _headers(),
    );
    final data = jsonDecode(res.body);
    if (res.statusCode >= 400) {
      throw Exception(data['message'] ?? 'Failed to load sessions');
    }
    return (data['data'] as List?) ?? [];
  }

  Future<Map<String, dynamic>> createSession({
    required String title,
    required String mode,
  }) async {
    final res = await http.post(
      Uri.parse('${AppConfig.apiBaseUrl}/sessions'),
      headers: _headers(),
      body: jsonEncode({
        'title': title,
        'mode': mode,
        'source': 'app',
      }),
    );
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) {
      throw Exception(data['message'] ?? 'Create failed');
    }
    return data;
  }

  Future<Map<String, dynamic>> getSession(int id) async {
    final res = await http.get(
      Uri.parse('${AppConfig.apiBaseUrl}/sessions/$id'),
      headers: _headers(),
    );
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) {
      throw Exception(data['message'] ?? 'Load failed');
    }
    return data;
  }

  Future<void> startSession(int id) async {
    await http.post(
      Uri.parse('${AppConfig.apiBaseUrl}/sessions/$id/start'),
      headers: _headers(),
    );
  }

  Future<void> endSession(int id) async {
    await http.post(
      Uri.parse('${AppConfig.apiBaseUrl}/sessions/$id/end'),
      headers: _headers(),
    );
  }

  Future<Map<String, dynamic>> askText(int id, String text) async {
    final res = await http.post(
      Uri.parse('${AppConfig.apiBaseUrl}/sessions/$id/ask/text'),
      headers: _headers(),
      body: jsonEncode({'text': text}),
    );
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) {
      throw Exception(data['message'] ?? 'Ask failed');
    }
    return data;
  }

  Future<Map<String, dynamic>> askAudio(int id, String filePath) async {
    final req = http.MultipartRequest(
      'POST',
      Uri.parse('${AppConfig.apiBaseUrl}/sessions/$id/ask/audio'),
    );
    req.headers.addAll(_headers(json: false));
    req.files.add(await http.MultipartFile.fromPath('file', filePath));
    final streamed = await req.send();
    final body = await streamed.stream.bytesToString();
    final data = jsonDecode(body) as Map<String, dynamic>;
    if (streamed.statusCode >= 400) {
      throw Exception(data['message'] ?? 'Audio failed');
    }
    return data;
  }

  Future<Map<String, dynamic>> askScreen(int id, String filePath) async {
    final req = http.MultipartRequest(
      'POST',
      Uri.parse('${AppConfig.apiBaseUrl}/sessions/$id/ask/screen'),
    );
    req.headers.addAll(_headers(json: false));
    req.files.add(await http.MultipartFile.fromPath('file', filePath));
    final streamed = await req.send();
    final body = await streamed.stream.bytesToString();
    final data = jsonDecode(body) as Map<String, dynamic>;
    if (streamed.statusCode >= 400) {
      throw Exception(data['message'] ?? 'Screen failed');
    }
    return data;
  }
}
