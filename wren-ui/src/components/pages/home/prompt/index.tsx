import {
  useEffect,
  useMemo,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { Input, Button } from 'antd';
import styled from 'styled-components';
import { PROCESS_STATE } from '@/utils/enum';
import PromptResult from '@/components/pages/home/prompt/Result';
import useAskProcessState, {
  getIsProcessing,
} from '@/hooks/useAskProcessState';
import { AskPromptData } from '@/hooks/useAskPrompt';
import {
  AskingTask,
  AskingTaskStatus,
  AskingTaskType,
  CreateThreadInput,
  CreateThreadResponseInput,
} from '@/apollo/client/graphql/__types__';

interface Props {
  onSelect: (
    payload: CreateThreadInput | CreateThreadResponseInput,
  ) => Promise<void>;
  onStop: () => void;
  onSubmit: (value: string) => Promise<void>;
  onStopPolling: () => void;
  onStopStreaming: () => void;
  onStopRecommend: () => void;
  data: AskPromptData;
  loading: boolean;
}

interface Attributes {
  setValue: (value: string) => void;
  submit: () => void;
  close: () => void;
}

const PromptStyle = styled.div`
  position: fixed;
  width: 680px;
  left: 50%;
  margin-left: calc(-340px + 133px);
  bottom: 18px;
  z-index: 999;
  box-shadow:
    rgba(0, 0, 0, 0.1) 0px 10px 15px -3px,
    rgba(0, 0, 0, 0.05) 0px 4px 6px -2px;
`;

const PromptButton = styled(Button)`
  min-width: 72px;
`;

const convertAskingTaskToProcessState = (data: AskingTask) => {
  const processState = {
    [AskingTaskStatus.UNDERSTANDING]: PROCESS_STATE.UNDERSTANDING,
    [AskingTaskStatus.SEARCHING]: PROCESS_STATE.SEARCHING,
    [AskingTaskStatus.GENERATING]: PROCESS_STATE.GENERATING,
    // Show generating state component when AI correcting
    [AskingTaskStatus.CORRECTING]: PROCESS_STATE.GENERATING,
    [AskingTaskStatus.FINISHED]: PROCESS_STATE.FINISHED,
  }[data.status];

  if (
    data?.type === AskingTaskType.TEXT_TO_SQL &&
    processState === PROCESS_STATE.FINISHED &&
    data.candidates.length === 0
  ) {
    return PROCESS_STATE.NO_RESULT;
  }
  return processState;
};

export default forwardRef<Attributes, Props>(function Prompt(props, ref) {
  const $promptInput = useRef<HTMLTextAreaElement>(null);
  const {
    data,
    loading,
    onSubmit,
    onStop,
    onSelect,
    onStopStreaming,
    onStopRecommend,
  } = props;
  const [inputValue, setInputValue] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const askProcessState = useAskProcessState();

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const {
    originalQuestion,
    askingTask,
    askingStreamTask,
    recommendedQuestions,
  } = data;

  const result = useMemo(
    () => ({
      type: askingTask?.type, // question's type
      originalQuestion, // original question
      candidates: askingTask?.candidates || [], // for text to sql answer, only one candidate
      askingStreamTask, // for general answer
      recommendedQuestions, // guiding user to ask
    }),
    [data],
  );
  const error = useMemo(() => askingTask?.error || null, [askingTask?.error]);
  const question = useMemo(() => inputValue.trim(), [inputValue]);
  const isProcessing = useMemo(
    () => getIsProcessing(askProcessState.currentState),
    [askProcessState.currentState],
  );

  useEffect(() => {
    if (!isProcessing) $promptInput.current?.focus();
  }, [isProcessing]);

  useEffect(() => {
    if (askingTask) {
      const processState = convertAskingTaskToProcessState(askingTask);
      askProcessState.setState(processState);
    }
  }, [askingTask]);

  useEffect(() => {
    if (error) {
      askProcessState.setState(PROCESS_STATE.FAILED);
    }
  }, [error]);

  const selectQuestion = async (payload) => {
    onSelect && (await onSelect(payload));
    closeResult();
    askProcessState.resetState();
  };

  const selectResult = async (payload) => {
    const isSavedViewCandidate = !!payload.viewId;

    let data = null;
    if (isSavedViewCandidate) {
      data = { viewId: payload.viewId, question };
    } else if (question) {
      data = {
        sql: payload.sql,
        question,
      };
    }
    if (!data) return;
    // keep the state as generating after the result is selected
    askProcessState.setState(PROCESS_STATE.GENERATING);
    onSelect && (await onSelect(data));
    closeResult();
    askProcessState.resetState();
  };

  const closeResult = () => {
    askProcessState.resetState();
    setInputValue('');
    onStopStreaming && onStopStreaming();
    onStopRecommend && onStopRecommend();
  };

  const stopProcess = () => {
    askProcessState.resetState();
    onStop && onStop();
  };

  const syncInputValue = (event) => {
    setInputValue(event.target.value);
  };

  const inputEnter = (event) => {
    if (event.shiftKey) return;
    event.preventDefault();
    submitAsk();
  };

  const submitAsk = async () => {
    if (isProcessing || !question) return;
    // start the state as understanding when user submit question
    askProcessState.setState(PROCESS_STATE.UNDERSTANDING);
    onSubmit && (await onSubmit(question));
  };

  const startRecording = () => {
    setIsRecording(true);
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(2048, 1, 1);
  
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          let isSilent = true;
          for (let i = 0; i < input.length; i++) {
            if (Math.abs(input[i]) > 0.02) { // Adjust the threshold value as needed
              isSilent = false;
              break;
            }
          }
  
          if (isSilent && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
          }
        };
  
        source.connect(processor);
        processor.connect(audioContext.destination);
  
        mediaRecorder.ondataavailable = e => {
          chunksRef.current.push(e.data);
        };
  
        mediaRecorder.onstop = async () => {
          const blob = new Blob(chunksRef.current, { type: 'audio/wav; codecs=opus' });
          chunksRef.current = [];
          const formData = new FormData();
          formData.append('audio', blob, 'audio.wav');
          try {
            const response = await fetch('http://10.10.61.200:8889/asr', {
              method: 'POST',
              body: formData,
            });
  
            console.error('Error:', response);
            const data = await response.json();
            if (!response.ok) throw new Error(data);
            console.log('Received data:', data); // Log the received data
            if (data.result) {
              setInputValue(data.result); // Update input value with the transcribed text
              console.log('Updated input value:', data.result); // Log the updated input value
              submitAsk(); // Submit Ask button
            } else {
              setInputValue('提出问题以探索您的数据'); // Set placeholder if result is empty
            }
          } catch (error) {
            console.error('Error:', error);
          } finally {
            // Clean up audio resources
            processor.disconnect();
            source.disconnect();
            audioContext.close().catch(console.error);
            setIsRecording(false);
          }
        };
  
        mediaRecorder.start();
      })
      .catch(error => console.error('Error:', error));
  };

  const stopRecording = () => {
    setIsRecording(false);
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      setValue: (value: string) => setInputValue(value),
      submit: submitAsk,
      close: closeResult,
    }),
    [question, isProcessing, setInputValue],
  );

  return (
    <PromptStyle className="d-flex align-end bg-gray-2 p-3 border border-gray-3 rounded"
    style={{
      marginLeft: '0px',
      transform: 'translateX(-50%)',
    }}
    >
      <Input.TextArea
        ref={$promptInput}
        // disable grammarly
        data-gramm="false"
        size="large"
        autoSize
        placeholder="提出问题以探索您的数据"
        value={inputValue}
        onInput={syncInputValue}
        onPressEnter={inputEnter}
        disabled={isProcessing}
      />
      <PromptButton
        type="primary"
        size="large"
        className="ml-3"
        onClick={submitAsk}
        disabled={isProcessing}
      >
        提问
      </PromptButton>
      <PromptButton
        type="default"
        size="large"
        className="ml-3"
        onClick={isRecording ? stopRecording : startRecording}
        disabled={isProcessing}
      >
        {isRecording ? '停止' : '语音'}
      </PromptButton>

      <PromptResult
        data={result}
        error={error}
        loading={loading}
        processState={askProcessState}
        onSelectQuestion={selectQuestion}
        onSelectResult={selectResult}
        onClose={closeResult}
        onStop={stopProcess}
      />
    </PromptStyle>
  );
});
