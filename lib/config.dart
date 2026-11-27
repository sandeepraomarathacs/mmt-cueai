class AppConfig {
  // Android emulator → host machine: 10.0.2.2
  // Physical device: use your PC LAN IP
  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:8000/api',
  );
}
