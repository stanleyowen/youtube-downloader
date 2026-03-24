import { useState } from 'react';
import { Download, CheckCircle2, Loader2 } from 'lucide-react';
import QualitySelect from './QualitySelect';

export default function PlaylistView({ playlist, onDownload, downloadingIds }) {
  const [selectedQuality, setSelectedQuality] = useState('720p');
  const [selectedVideos, setSelectedVideos] = useState(new Set());

  const defaultQualities = [
    { quality: '1080p', label: '1080p HD' },
    { quality: '720p', label: '720p' },
    { quality: '480p', label: '480p' },
    { quality: '360p', label: '360p' },
    { quality: 'audio', label: 'MP3 Audio' }
  ];

  const toggleVideo = (id) => {
    const newSelected = new Set(selectedVideos);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedVideos(newSelected);
  };

  const selectAll = () => {
    if (selectedVideos.size === playlist.videos.length) {
      setSelectedVideos(new Set());
    } else {
      setSelectedVideos(new Set(playlist.videos.map(v => v.id)));
    }
  };

  const downloadSelected = () => {
    selectedVideos.forEach(id => {
      const video = playlist.videos.find(v => v.id === id);
      if (video && !downloadingIds.has(id)) {
        onDownload(video.url, selectedQuality, id);
      }
    });
  };

  return (
    <div className="w-full max-w-4xl">
      <div className="bg-white dark:bg-gray-800 rounded-xl p-6 shadow-lg border border-gray-100 dark:border-gray-700 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">
              {playlist.title}
            </h2>
            <p className="text-gray-500 dark:text-gray-400">
              {playlist.videoCount} videos
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-40">
              <QualitySelect
                qualities={defaultQualities}
                value={selectedQuality}
                onChange={setSelectedQuality}
              />
            </div>
            <button
              onClick={selectAll}
              className="px-4 py-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              {selectedVideos.size === playlist.videos.length ? 'Deselect All' : 'Select All'}
            </button>
            <button
              onClick={downloadSelected}
              disabled={selectedVideos.size === 0}
              className="px-4 py-3 bg-red-500 hover:bg-red-600 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white font-medium rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Download className="h-5 w-5" />
              Download ({selectedVideos.size})
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-3">
        {playlist.videos.map((video, index) => (
          <div
            key={video.id}
            className={`flex items-center gap-4 p-4 bg-white dark:bg-gray-800 rounded-xl border transition-all cursor-pointer ${
              selectedVideos.has(video.id)
                ? 'border-red-500 ring-2 ring-red-500/20'
                : 'border-gray-100 dark:border-gray-700 hover:border-gray-200 dark:hover:border-gray-600'
            }`}
            onClick={() => toggleVideo(video.id)}
          >
            <div className="flex-shrink-0 w-8 text-center text-gray-400 font-medium">
              {index + 1}
            </div>
            <div className="relative flex-shrink-0">
              <img
                src={video.thumbnail}
                alt={video.title}
                className="w-32 h-18 object-cover rounded-lg"
              />
              {video.duration && (
                <span className="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded">
                  {video.duration}
                </span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-gray-900 dark:text-white truncate">
                {video.title}
              </h3>
            </div>
            <div className="flex-shrink-0">
              {downloadingIds.has(video.id) ? (
                <Loader2 className="h-6 w-6 text-red-500 animate-spin" />
              ) : selectedVideos.has(video.id) ? (
                <CheckCircle2 className="h-6 w-6 text-red-500" />
              ) : (
                <div className="h-6 w-6 border-2 border-gray-300 dark:border-gray-600 rounded-full" />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
