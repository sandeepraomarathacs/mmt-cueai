import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'screens/login_screen.dart';
import 'screens/sessions_screen.dart';
import 'services/api_service.dart';

final api = ApiService();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await api.loadToken();
  final prefs = await SharedPreferences.getInstance();
  final hasToken = (prefs.getString('token') ?? '').isNotEmpty;
  runApp(ParakeetApp(hasToken: hasToken));
}

class ParakeetApp extends StatelessWidget {
  const ParakeetApp({super.key, required this.hasToken});

  final bool hasToken;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Parakeet',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF0F766E),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFF07131A),
      ),
      home: hasToken ? const SessionsScreen() : const LoginScreen(),
    );
  }
}
