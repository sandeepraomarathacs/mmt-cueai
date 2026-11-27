import 'package:flutter/material.dart';

import '../main.dart';
import 'live_session_screen.dart';
import 'login_screen.dart';

class SessionsScreen extends StatefulWidget {
  const SessionsScreen({super.key});

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  List<dynamic> sessions = [];
  final titleCtrl = TextEditingController();
  String mode = 'interview';
  String? error;
  bool loading = true;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    setState(() => loading = true);
    try {
      sessions = await api.sessions();
      error = null;
    } catch (e) {
      error = e.toString();
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> create() async {
    if (titleCtrl.text.trim().isEmpty) return;
    try {
      final session = await api.createSession(title: titleCtrl.text.trim(), mode: mode);
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => LiveSessionScreen(sessionId: session['id'] as int)),
      );
      load();
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  Future<void> logout() async {
    await api.clearToken();
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const LoginScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Parakeet'),
        actions: [
          IconButton(onPressed: logout, icon: const Icon(Icons.logout)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: load,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text('Create session', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                    if (error != null) Text(error!, style: const TextStyle(color: Colors.redAccent)),
                    TextField(
                      controller: titleCtrl,
                      decoration: const InputDecoration(labelText: 'Title'),
                    ),
                    DropdownButtonFormField<String>(
                      value: mode,
                      items: const [
                        DropdownMenuItem(value: 'interview', child: Text('Interview')),
                        DropdownMenuItem(value: 'sales', child: Text('Sales')),
                        DropdownMenuItem(value: 'meeting', child: Text('Meeting')),
                        DropdownMenuItem(value: 'regular', child: Text('Regular')),
                      ],
                      onChanged: (v) => setState(() => mode = v ?? 'interview'),
                    ),
                    const SizedBox(height: 12),
                    FilledButton(onPressed: create, child: const Text('Start session')),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            if (loading) const Center(child: CircularProgressIndicator()),
            ...sessions.map((s) {
              return Card(
                child: ListTile(
                  title: Text(s['title']?.toString() ?? 'Session'),
                  subtitle: Text('${s['mode']} · ${s['status']}'),
                  trailing: Text(s['source']?.toString() ?? ''),
                  onTap: () async {
                    await Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => LiveSessionScreen(sessionId: s['id'] as int),
                      ),
                    );
                    load();
                  },
                ),
              );
            }),
          ],
        ),
      ),
    );
  }
}
