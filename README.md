# Automatic-kirinuki-subtitler
An AI-enpowered subtitle maker and translator designed for fans to clip, transcribe and translate clips of their favourite celebrities.

Currently working on translations JP -> CN specifically.

The program is still under development. Stay tuned for more updates!

## tl;dr

**STILL UNDER DEVELOPMENT. LOTS OF BUGS AND MISSING FEATURES. THERE ISN'T A STABLY USABLE VERSION YET.**

**USE AT YOUR OWN RISK IF YOU WISH TO USE IT RIGHT NOW.**

- All-in-one clipping, auto-transcribing, translating, and rendering tool based on webapp
- Code done almost entirely by AI agents (Claude Fable 5, Claude Sonnet 5), with me supervising the work
- requires `api-key` from your selected LLM provider for translation work. Currently supports `OpenAI Format`
- uses `faster-whisper-v3` for transcription
- Integrated subtitle editor. Still under construction.

## Background

For the grounds of our discussion, I'm mainly focusing on international audiences trying to make translations or clips for Japanese (internet) celebrities, their free radio shows, youtube videos or livestreams. This discussion is not applicable to Japanese clipping teams, as their work were more leaned towards reality TV show editing style, rather than heavily focused on transcription and translation.

Making translations of clips (a.k.a. 切り抜き) of your favourite vtubers/voice actresses/radio shows for an international audience used to be a hassle. Fans often had to seek for other fans who has highly aglined interests and a keen determination to devote their precious time, form a subtitling group, and co-operate intensively in order to produce translated clips of one celebrity that they both like. In a traditional approach, there would often be a translator, a timeline syncronization worker, a QC worker, a social officier, and a technical support. The translator would be in charge of listening to the raw video and providing a translated text file. The timeline syncronization worker would then take the text file, and synchornize the translated text to the original video. This working file would then be sent to a QC worker who checks any inaccuracies or unnatural bits in the translation and the timeline. Then the working file would be sent to a techincal support, who's in charge of rendering a final video file, and sometimes creating graphics for the video. Finally the video would be sent to the social officier who's in charge of uploading the video and managing the social media account of this translation group. As can be seen, such procedures require lots of personnel and tedious communication between team members. People who voluenteer to co-operate are often young individuals lacking experience in administration, task delegation and negotiation, disputes occur inside those translation groups, often leading to unhappy interpersonal relationship dramas, sometimes cyberbullying which poses personal security threats upon individuals. Eventually, such drama often leads to dissolution of subtitling groups. Besides the risks in communication, often translation works are very intense as the celebrity might be very diligent in releasing contents. It is also very hard for fans, especially for fans in niche fandoms, to find individuals with enough resillience and perseverance to make translations in a long run.

Thanks to the advance of AI technology, such procedure could be largely automated using automated scripts. Contemporary subtitling groups are much smaller, often containing only one or two people. People have been keen on feeding a whole video file to multimodel AI providers to get a sensible first draft of the translation file, then only work on QC after that.

However, people don't often translate a whole video posted by their favourite celebrity. For a wider audience on the internet and shorter attention span of contemporary audiences, people often make clips from long videos which often only contains a highlight from a video. Traditionally such clipping were tedious, as they either had to be done in a non-linear video editing software (which requires lots of computer space and a tremendous amount of time in learning how to operate them), or noting down timestamps and manually doing them using command-line ffmpeg. 

Therefore, in response to the questions discussed above, I have made this all-in-one clipping, auto-transcribing, translating and rendering tool which runs on webapp, which hopefully could make the whole clipping, subtitle editing, rendering and distribution work possible even for a single individual.

## Approach

### Clipping

In this work, you'll be able to mark clips of a video using a live video preview integrated into the software. 

You'll be able to 

- Make multiple clips

- Give them distinct names

- Make notes to those clips as a reminder

- And batch-process multiple clips into the automatic translation and transcription pipeline. (TBD)

### Transcription and translation

Translation is done by API requests to a LLM provider of your choice. Now compatiable with OpenAI format endpoints.

Transcription is done by faster-whisper-v3 which runs locally on your machine. You'll be able to choose from different speech-to-text models in the future. (TBD)

### QC/Subtitle editing

Inspired by `Aegisub`. You'll be able to

- Fine-tune timelines

- preview cps

- adjust translations

- adjust positions of texts

- adjust format of texts

- with a spectrogram view

### Rendering

A choice from 

- Dual language subtitles

- Single language subtitle

- Render with video or only subtitle file


More information TBC!

