import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import '../main.dart';

class LiveSessionScreen extends StatefulWidget {
  const LiveSessionScreen({super.key, required this.sessionId});

  final int sessionId;

  @override
  State<LiveSessionScreen> createState() => _LiveSessionScreenState();
}

class _LiveSessionScreenState extends State<LiveSessionScreen> {
  Map<String, dynamic>? session;
  List<dynamic> messages = [];
  final textCtrl = TextEditingController();
  final recorder = AudioRecorder();
  String answer = '';
  String? error;
  bool busy = false;
  bool recording = false;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final s = await api.getSession(widget.sessionId);
      if (s['status'] == 'ready') {
        await api.startSession(widget.sessionId);
      }
      setState(() {
        session = s;
        messages = (s['messages'] as List?) ?? [];
        error = null;
      });
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  Future<void> askText() async {
    if (textCtrl.text.trim().isEmpty) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final res = await api.askText(widget.sessionId, textCtrl.text.trim());
      setState(() {
        answer = res['answer']?.toString() ?? '';
        if (res['message'] != null) messages = [res['message'], ...messages];
        textCtrl.clear();
      });
    } catch (e) {
      setState(() => error = e.toString());
    } finally {
      setState(() => busy = false);
    }
  }

  Future<void> toggleMic() async {
    if (recording) {
      final path = await recorder.stop();
      setState(() => recording = false);
      if (path == null) return;
      setState(() => busy = true);
      try {
        final res = await api.askAudio(widget.sessionId, path);
        setState(() {
          answer = res['answer']?.toString() ?? '';
          if (res['message'] != null) messages = [res['message'], ...messages];
        });
      } catch (e) {
        setState(() => error = e.toString());
      } finally {
        setState(() => busy = false);
      }
      return;
    }

    if (!await recorder.hasPermission()) {
      setState(() => error = 'Microphone permission denied');
      return;
    }
    final dir = await getTemporaryDirectory();
    final path = '${dir.path}/parakeet_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await recorder.start(const RecordConfig(), path: path);
    setState(() => recording = true);
  }

  Future<void> pickImage() async {
    final picker = ImagePicker();
    final file = await picker.pickImage(source: ImageSource.gallery);
    if (file == null) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final res = await api.askScreen(widget.sessionId, file.path);
      setState(() {
        answer = res['answer']?.toString() ?? '';
        if (res['message'] != null) messages = [res['message'], ...messages];
      });
    } catch (e) {
      setState(() => error = e.toString());
    } finally {
      setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    recorder.dispose();
    textCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(session?['title']?.toString() ?? 'Session'),
        actions: [
          TextButton(
            onPressed: () async {
              await api.endSession(widget.sessionId);
              if (mounted) Navigator.pop(context);
            },
            child: const Text('End'),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (error != null) Text(error!, style: const TextStyle(color: Colors.redAccent)),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Live answer', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 8),
                  Text(answer.isEmpty ? 'Ask with text, mic, or image.' : answer),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    children: [
                      FilledButton.tonal(
                        onPressed: busy ? null : toggleMic,
                        child: Text(recording ? 'Stop mic' : 'Record mic'),
                      ),
                      FilledButton.tonal(
                        onPressed: busy ? null : pickImage,
                        child: const Text('Pick image'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: textCtrl,
                    maxLines: 4,
                    decoration: const InputDecoration(
                      labelText: 'Ask with text',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: busy ? null : askText,
                    child: Text(busy ? 'Processing…' : 'Get answer'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          const Text('History', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          ...messages.map((m) {
            return Card(
              child: ListTile(
                title: Text(m['channel']?.toString() ?? ''),
                subtitle: Text(m['answer']?.toString() ?? ''),
              ),
            );
          }),
        ],
      ),
    );
  }
}
