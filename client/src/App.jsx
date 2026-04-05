import { useState, useEffect } from 'react';
import { Moon, Sun, Download, Loader2, AlertCircle, Youtube } from 'lucide-react';
import UrlInput from './components/UrlInput';
import VideoCard from './components/VideoCard';
import QualitySelect from './components/QualitySelect';
import PlaylistView from './components/PlaylistView';

const API_BASE = '/api';

export default function App() {
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [videoInfo, setVideoInfo] = useState(null);
  const [selectedQuality, setSelectedQuality] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState('');
  const [downloadingIds, setDownloadingIds] = useState(new Set());

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  const fetchInfo = async (url) => {
    setLoading(true);
    setError(null);
    setVideoInfo(null);

    try {
      const response = await fetch(`${API_BASE}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch video info');
      }

      setVideoInfo(data);
      if (data.qualities && data.qualities.length > 0) {
        setSelectedQuality(data.qualities[0].quality);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const startDownload = async (url, quality, videoId = null) => {
    if (videoId) {
      setDownloadingIds(prev => new Set([...prev, videoId]));
    } else {
      setDownloading(true);
      setDownloadProgress('Starting download...');
    }
    setError(null);

    try {
      // Start the download
      const response = await fetch(`${API_BASE}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, quality })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start download');
      }

      const downloadId = data.downloadId;
      if (!videoId) {
        setDownloadProgress('Processing video...');
      }

      // Poll for completion
      let attempts = 0;
      const maxAttempts = 120; // 2 minutes timeout

      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const statusResponse = await fetch(`${API_BASE}/status/${downloadId}`);
        const statusData = await statusResponse.json();

        if (statusData.status === 'ready') {
          // Trigger download
          window.location.href = `${API_BASE}/file/${downloadId}`;

          if (videoId) {
            setDownloadingIds(prev => {
              const newSet = new Set(prev);
              newSet.delete(videoId);
              return newSet;
            });
          } else {
            setDownloadProgress('Download started!');
            setTimeout(() => {
              setDownloading(false);
              setDownloadProgress('');
            }, 2000);
          }
          return;
        } else if (statusData.status === 'error') {
          throw new Error(statusData.error || 'Download failed');
        }

        attempts++;
        if (!videoId) {
          setDownloadProgress(`Processing... (${attempts}s)`);
        }
      }

      throw new Error('Download timed out');
    } catch (err) {
      setError(err.message);
      if (videoId) {
        setDownloadingIds(prev => {
          const newSet = new Set(prev);
          newSet.delete(videoId);
          return newSet;
        });
      } else {
        setDownloading(false);
        setDownloadProgress('');
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 transition-colors">
      {/* Header */}
      <header className="p-4 flex justify-end">
        <button
          onClick={() => setDarkMode(!darkMode)}
          className="p-2 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        >
          {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 pb-16">
        {/* Hero Section */}
        <div className="flex flex-col items-center pt-12 pb-12">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-red-500 rounded-2xl">
              <Youtube className="h-8 w-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              YouTube Downloader
            </h1>
          </div>
          <p className="text-gray-500 dark:text-gray-400 mb-8 text-center">
            Download videos and playlists in any quality
          </p>

          <UrlInput onSubmit={fetchInfo} loading={loading} />

          {/* Error Message */}
          {error && (
            <div className="mt-4 flex items-center gap-2 text-red-500 bg-red-50 dark:bg-red-900/20 px-4 py-3 rounded-lg">
              <AlertCircle className="h-5 w-5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Video/Playlist Display */}
        <div className="flex flex-col items-center">
          {videoInfo && !videoInfo.isPlaylist && (
            <div className="w-full max-w-md">
              <VideoCard video={videoInfo} />

              <div className="mt-6 space-y-4">
                <QualitySelect
                  qualities={videoInfo.qualities}
                  value={selectedQuality}
                  onChange={setSelectedQuality}
                />

                <button
                  onClick={() => startDownload(`https://www.youtube.com/watch?v=${videoInfo.id}`, selectedQuality)}
                  disabled={downloading}
                  className="w-full py-4 bg-red-500 hover:bg-red-600 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white font-semibold rounded-xl transition-all disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {downloading ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      <span>{downloadProgress}</span>
                    </>
                  ) : (
                    <>
                      <Download className="h-5 w-5" />
                      <span>Download</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {videoInfo && videoInfo.isPlaylist && (
            <PlaylistView
              playlist={videoInfo}
              onDownload={startDownload}
              downloadingIds={downloadingIds}
            />
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 p-4 text-center text-sm text-gray-400 dark:text-gray-500">
        For personal use only
      </footer>
    </div>
  );
}
